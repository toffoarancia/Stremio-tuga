'use strict';

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-core');

const BASE = 'https://osteusfilmestuga.online';
const LOGO = `${BASE}/wp-content/uploads/2021/11/Os-Teus-Filmes-Tuga.png`;
const PORT = process.env.PORT || 7860;

// ─── Browser pool (single shared instance) ───────────────────────────────────

let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/chromium',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--mute-audio',
      '--disable-web-security',     // allow cross-origin iframe inspection
    ],
  });
  browser.on('disconnected', () => { browser = null; });
  return browser;
}

// ─── HTTP helper (for catalog/meta — no JS needed) ───────────────────────────

async function get(url, retries = 3) {
  const UAS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
  ];
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UAS[i % UAS.length],
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
          'Referer': BASE,
        },
        timeout: 25000,
        redirect: 'follow',
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return text;
    } catch (e) {
      console.error(`[get] attempt ${i + 1} failed: ${e.message}`);
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

// ─── Stream extraction via zetaplayer REST API ────────────────────────────────
// The site uses the "zetaplayer" WordPress plugin.
// Player URLs are served via: /wp-json/zetaplayer/v2/{post_id}/{option_index}
// The post ID is embedded in the page HTML as <body class="... postid-XXXX ...">
// or in inline JS as ztAjax.classitem or data attributes.

const AD_BLOCK_PATTERNS = [
  'googlesyndication', 'doubleclick', 'googletagmanager', 'google-analytics',
  'adnxs', 'taboola', 'outbrain', 'amazon-adsystem', 'facebook.com/tr',
  'analytics', 'hotjar', 'clarity.ms', 'adsbygoogle',
];

function isAd(url) {
  return AD_BLOCK_PATTERNS.some(p => url.includes(p));
}

// Extract streams for a TV episode using admin-ajax (play_method_ep=admin_ajax)
// The site uses admin-ajax.php for episodes, not the zetaplayer REST API
async function extractStreamsForEpisode(pid, sec) {
  const streams = [];
  const br = await getBrowser();
  const page = await br.newPage();

  try {
    await page.setRequestInterception(true);
    const apiResponses = [];

    page.on('response', async resp => {
      const u = resp.url();
      if (u.includes('admin-ajax') || u.includes('zetaplayer')) {
        try {
          const text = await resp.text().catch(() => '');
          if (text.includes('embed') || text.includes('play') || text.length > 20) {
            apiResponses.push({ url: u, body: text });
            console.log('[epstream] intercepted: ' + u.slice(-50) + ' -> ' + text.slice(0, 100));
          }
        } catch {}
      }
      if (resp.url().match(/\.(mp4|m3u8)(\?|$)/i)) {
        streams.push({ title: '▶ Direto PT', url: resp.url() });
      }
    });

    page.on('request', req => {
      const u = req.url(), rt = req.resourceType();
      if (['image','font','media'].includes(rt)) return req.abort();
      if (['googlesyndication','doubleclick'].some(h => u.includes(h))) return req.abort();
      req.continue();
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');

    // Login
    await page.goto('https://osteusfilmestuga.online/a-minha-conta/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const uf = await page.$('#username') || await page.$('input[name="username"]') || await page.$('input[type="email"]');
    const pf = await page.$('#password') || await page.$('input[name="password"]') || await page.$('input[type="password"]');
    if (uf && pf) {
      await uf.type(process.env.WP_USER || '', { delay: 20 });
      await pf.type(process.env.WP_PASS || '', { delay: 20 });
      const btn = await page.$('button[name="login"]') || await page.$('button[type="submit"]');
      if (btn) await Promise.all([btn.click(), page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})]);
    }

    // Call admin-ajax.php with the episode action
    // JS config shows: play_method_ep = "admin_ajax"
    const embedHtml = await page.evaluate(async (pid, sec) => {
      // Try zetaplayer AJAX action for episodes
      const actions = ['zetaplayer', 'zt_player', 'zetaflix_player', 'get_player'];
      for (const action of actions) {
        try {
          const fd = new FormData();
          fd.append('action', action);
          fd.append('post_id', pid);
          fd.append('nume', '1');
          fd.append('type', 'ep');
          fd.append('nonce', sec);
          const r = await fetch('/wp-admin/admin-ajax.php', { method: 'POST', body: fd, credentials: 'include' });
          const text = await r.text();
          if (text && text !== '0' && text !== '-1' && text.length > 5) {
            return { action, text };
          }
        } catch(e) {}
      }
      // Try zetaplayer REST API with ep type
      try {
        const r = await fetch('/wp-json/zetaplayer/v2/' + pid + '/ep/1', { credentials: 'include' });
        const text = await r.text();
        return { action: 'rest_ep', text };
      } catch(e) {}
      return null;
    }, pid, sec);

    console.log('[epstream] embedHtml: ' + JSON.stringify(embedHtml)?.slice(0, 200));

    if (embedHtml && embedHtml.text && embedHtml.text !== '0') {
      try {
        const data = JSON.parse(embedHtml.text);
        let embedUrl = null;
        if (data.embed_url) {
          const m = data.embed_url.match(/(?:src|SRC)=["']([^"']+)["']/i);
          if (m) embedUrl = m[1];
        }
        if (!embedUrl && data.play_url) embedUrl = data.play_url;
        if (embedUrl && embedUrl.startsWith('http')) {
          const direct = await extractDirectVideo(embedUrl).catch(() => null);
          if (direct) {
            streams.push({ title: '▶ PT (direto)', url: direct });
          } else {
            try {
              const host = new URL(embedUrl).hostname.replace('www.', '');
              streams.push({ title: '▶ Player (' + host + ')', externalUrl: embedUrl });
            } catch {}
          }
        }
      } catch(e) {
        // Not JSON — maybe raw embed HTML
        const m = embedHtml.text.match(/(?:src|SRC)=["']([^"'<>\s]+)["']/i);
        if (m && m[1].startsWith('http')) {
          streams.push({ title: '▶ Episódio', externalUrl: m[1] });
        }
      }
    }

  } catch(e) {
    console.error('[epstream] error: ' + e.message);
  } finally {
    await page.close().catch(() => {});
  }

  if (streams.length === 0) {
    streams.push({ title: '🌐 Abrir no browser', externalUrl: BASE + '/episodio/' });
  }
  return streams;
}

async function extractStreams(pageUrl) {
  // The zetaplayer API requires a logged-in WordPress session.
  // Strategy: use Puppeteer to log in, then navigate to the page,
  // click the player tab, and intercept the iframe src that loads.

  const streams = [];
  const seen = new Set();
  function addStream(s) {
    const key = s.url || s.externalUrl || '';
    if (key && !seen.has(key)) { seen.add(key); streams.push(s); }
  }

  const SKIP_HOSTS = ['recaptcha', 'google.com', 'youtube.com', 'youtu.be',
    'facebook.com', 'disqus.com', 'variationconfused', 'googlesyndication',
    'doubleclick', 'amazon-adsystem', 'osteusfilmestuga.online'];
  function isPlayerEmbed(src) {
    if (!src || !src.startsWith('http')) return false;
    try { return !SKIP_HOSTS.some(s => src.includes(s)); } catch { return false; }
  }

  const br = await getBrowser();
  const page = await br.newPage();

  try {
    await page.setRequestInterception(true);

    // Capture all responses — we want the zetaplayer API call after login
    let playerEmbedUrl = null;
    const apiResponses = [];

    page.on('response', async resp => {
      const u = resp.url();
      if (u.includes('zetaplayer') || (u.includes('admin-ajax') && !u.includes('counting'))) {
        try {
          const text = await resp.text().catch(() => '');
          console.log('[streams] intercepted: ' + u + ' -> ' + text.slice(0, 200));
          apiResponses.push({ url: u, body: text });
          // Parse embed URL from response
          try {
            const data = JSON.parse(text);
            if (data.embed_url) {
              // embed_url is an HTML string like <IFRAME SRC="https://...">
              const srcMatch = data.embed_url.match(/(?:src|SRC)=[\"']+([^\"']+)[\"']/i);
              if (srcMatch) playerEmbedUrl = srcMatch[1];
            }
            if (!playerEmbedUrl && data.play_url && data.play_url.startsWith('http')) {
              playerEmbedUrl = data.play_url;
            }
          } catch {}
        } catch {}
      }
      // Direct video
      if (resp.url().match(/\.(mp4|m3u8)(\?|$)/i)) {
        addStream({ title: '▶ Direto PT', url: resp.url() });
      }
    });

    page.on('request', req => {
      const u = req.url();
      const rt = req.resourceType();
      // Block ads and binary media only — allow ALL scripts so zetaplayer works
      if (['image', 'font', 'media'].includes(rt)) return req.abort();
      if (['googlesyndication','doubleclick','amazon-adsystem','taboola','outbrain','variationconfused','hotjar','clarity.ms'].some(h => u.includes(h))) return req.abort();
      req.continue();
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');

    // Step 1: Log in via WooCommerce My Account page
    console.log('[streams] logging in...');
    await page.goto('https://osteusfilmestuga.online/a-minha-conta/', { waitUntil: 'domcontentloaded', timeout: 20000 });

    // WooCommerce login fields: #username and #password
    // Try multiple possible selectors
    // Try all possible login field selectors
    const userField = await page.$('#username')
      || await page.$('input[name="username"]')
      || await page.$('input[name="email"]')
      || await page.$('input[type="email"]')
      || await page.$('#user_login')
      || await page.$('input[autocomplete="username"]')
      || await page.$('input[autocomplete="email"]');
    const passField = await page.$('#password')
      || await page.$('input[name="password"]')
      || await page.$('#user_pass')
      || await page.$('input[type="password"]')
      || await page.$('input[autocomplete="current-password"]');

    console.log('[streams] userField=' + (userField ? 'found' : 'NOT FOUND'));
    console.log('[streams] passField=' + (passField ? 'found' : 'NOT FOUND'));

    if (userField && passField) {
      await userField.click({ clickCount: 3 });
      await userField.type(process.env.WP_USER || 'toffoarancia@googlemail.com', { delay: 30 });
      await passField.click({ clickCount: 3 });
      await passField.type(process.env.WP_PASS || '60Toffo60!', { delay: 30 });

      // Submit — try multiple button selectors
      const submitBtn = await page.$('button[name="login"]') || await page.$('input[type="submit"]') || await page.$('button[type="submit"]') || await page.$('.woocommerce-form-login__submit');
      if (submitBtn) {
        await Promise.all([
          submitBtn.click(),
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        ]);
      }
    }
    const loggedInUrl = page.url();
    console.log('[streams] after login, url=' + loggedInUrl);

    // Step 2: Navigate to content page
    console.log('[streams] navigating to ' + pageUrl);
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    // Wait for player tabs to appear (episode pages load them via AJAX)
    try {
      await page.waitForSelector('li.zetaflix_player_option', { timeout: 8000 });
    } catch(e) {
      console.log('[streams] player tabs did not appear, trying anyway');
    }

    // Step 3: Click each player tab using JS and wait for zetaplayer API response
    const tabCount = await page.evaluate(() =>
      document.querySelectorAll('li.zetaflix_player_option').length
    );
    console.log('[streams] found ' + tabCount + ' player tabs');

    for (let i = 0; i < Math.min(tabCount, 3); i++) {
      playerEmbedUrl = null;

      // Use JS click — more reliable than Puppeteer .click() for custom event handlers
      await page.evaluate((idx) => {
        const tabs = document.querySelectorAll('li.zetaflix_player_option');
        if (tabs[idx]) {
          tabs[idx].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
      }, i);

      // Wait for zetaplayer API response (up to 6 seconds)
      const start = Date.now();
      while (!playerEmbedUrl && Date.now() - start < 6000) {
        await new Promise(r => setTimeout(r, 500));
      }
      console.log('[streams] tab ' + (i+1) + ' playerEmbedUrl=' + playerEmbedUrl);

      if (playerEmbedUrl && isPlayerEmbed(playerEmbedUrl)) {
        const direct = await extractDirectVideo(playerEmbedUrl).catch(() => null);
        if (direct) {
          addStream({ title: '▶ Player ' + (i+1) + ' PT (direto)', url: direct });
        } else {
          try {
            const host = new URL(playerEmbedUrl).hostname.replace('www.', '');
            addStream({ title: '▶ Player ' + (i+1) + ' (' + host + ')', externalUrl: playerEmbedUrl, behaviorHints: { notWebReady: true } });
          } catch {}
        }
        continue;
      }

      // Fallback: check iframe src in DOM
      const iframes = await page.evaluate(() =>
        Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, id: f.id, cls: f.className }))
      );
      console.log('[streams] tab ' + (i+1) + ' iframes: ' + JSON.stringify(iframes.map(f => f.src)));
      for (const f of iframes) {
        if (isPlayerEmbed(f.src) && !f.src.includes('osteusfilmestuga')) {
          const direct = await extractDirectVideo(f.src).catch(() => null);
          if (direct) {
            addStream({ title: '▶ Player ' + (i+1) + ' PT (direto)', url: direct });
          } else {
            try {
              const host = new URL(f.src).hostname.replace('www.', '');
              addStream({ title: '▶ Player ' + (i+1) + ' (' + host + ')', externalUrl: f.src, behaviorHints: { notWebReady: true } });
            } catch {}
          }
        }
      }
    }

  } catch(e) {
    console.error('[streams] error: ' + e.message);
  } finally {
    await page.close().catch(() => {});
  }

  addStream({ title: '🌐 Abrir no browser', externalUrl: pageUrl });
  return streams;
}


async function extractDirectVideo(playerUrl) {
  const br = await getBrowser();
  const page = await br.newPage();
  let foundUrl = null;
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      const rt = req.resourceType();
      if (['image', 'font', 'media'].includes(rt)) return req.abort();
      if (['googlesyndication','doubleclick','amazon-adsystem'].some(h => u.includes(h))) return req.abort();
      if (u.match(/\.(mp4|m3u8|mkv|webm)(\?|$)/i)) foundUrl = u;
      req.continue();
    });
    page.on('response', resp => {
      if (resp.url().match(/\.(mp4|m3u8|mkv|webm)(\?|$)/i)) foundUrl = resp.url();
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    await page.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await new Promise(r => setTimeout(r, 4000));
    if (!foundUrl) {
      foundUrl = await page.evaluate(() => {
        const v = document.querySelector('video source[src], video[src]');
        if (v) return v.src || v.getAttribute('src');
        for (const s of document.querySelectorAll('script:not([src])')) {
          const m = s.textContent.match(/["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)/i);
          if (m) return m[1];
        }
        return null;
      }).catch(() => null);
    }
    console.log('[directVideo] ' + playerUrl + ' -> ' + (foundUrl || 'not found'));
  } catch(e) {
    console.error('[directVideo] error: ' + e.message);
  } finally {
    await page.close().catch(()=>{});
  }
  return foundUrl;
}

// Puppeteer fallback — click zetaflix player tabs and collect iframes
async function extractStreamsWithPuppeteer(pageUrl) {
  const br = await getBrowser();
  const page = await br.newPage();
  const streams = [];
  const seen = new Set();
  function addStream(s) {
    const key = s.url || s.externalUrl || '';
    if (key && !seen.has(key)) { seen.add(key); streams.push(s); }
  }
  const SKIP = ['recaptcha','google.com','youtube.com','youtu.be','facebook.com','disqus.com','osteusfilmestuga.online','variationconfused'];
  function isPlayer(src) {
    if (!src || !src.startsWith('http')) return false;
    try { return !SKIP.some(s => new URL(src).hostname.includes(s)); } catch { return false; }
  }
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (isAd(req.url())) return req.abort();
      if (['image','font','stylesheet'].includes(req.resourceType())) return req.abort();
      req.continue();
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    const tabs = await page.$$('#playeroptionsul li.zetaflix_player_option, li.zetaflix_player_option');
    console.log('[puppeteer] found ' + tabs.length + ' zetaflix tabs');
    const allSrcs = new Set();
    for (let i = 0; i < Math.min(tabs.length, 3); i++) {
      await tabs[i].click().catch(()=>{});
      await new Promise(r => setTimeout(r, 3000));
      const srcs = await page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map(f => f.src));
      srcs.filter(isPlayer).forEach(s => allSrcs.add(s));
    }
    for (const src of allSrcs) {
      const direct = await extractDirectVideo(src).catch(()=>null);
      if (direct) addStream({ title: '▶ PT (direto)', url: direct });
      else {
        try { addStream({ title: '▶ ' + new URL(src).hostname, externalUrl: src, behaviorHints: { notWebReady: true } }); } catch {}
      }
    }
  } catch(e) {
    console.error('[puppeteer fallback] ' + e.message);
  } finally {
    await page.close().catch(()=>{});
  }
  return streams;
}


// Fetch HTML via proxy (bypasses Cloudflare IP blocks on HF servers)
// Tries multiple free proxies in sequence
const PROXIES = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

async function puppeteerGet(url) {
  // Try each proxy in sequence
  for (let i = 0; i < PROXIES.length; i++) {
    const proxyUrl = PROXIES[i](url);
    try {
      console.log('[proxy] trying proxy ' + i + ' for ' + url);
      const resp = await fetch(proxyUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 20000,
      });
      if (!resp.ok) { console.log('[proxy] proxy ' + i + ' returned ' + resp.status); continue; }
      const text = await resp.text();
      if (text.length < 500) { console.log('[proxy] proxy ' + i + ' returned too short: ' + text.length); continue; }
      if (text.includes('Page Not Found') && text.length < 5000) { continue; }
      console.log('[proxy] proxy ' + i + ' success: ' + text.length + ' bytes');
      return text;
    } catch(e) {
      console.log('[proxy] proxy ' + i + ' error: ' + e.message);
    }
  }
  throw new Error('All proxies failed for ' + url);
}

// ─── ID / URL helpers ────────────────────────────────────────────────────────

function movieId(slug)   { return `tuga:movie:${slug}`; }
function seriesId(slug)  { return `tuga:series:${slug}`; }
function slugFromUrl(url) {
  const m = url.match(/osteusfilmestuga\.online\/(?:filmes|series)\/([^/?#]+)/);
  return m ? m[1] : null;
}
function movieUrl(slug)  { return `${BASE}/filmes/${slug}/`; }
function seriesUrl(slug) { return `${BASE}/series/${slug}/`; }
function episodePageUrl(slug, s, e) {
  return `${BASE}/episodio/${slug}-temporada-${s}-episodio-${e}/`;
}

// ─── Scrape listing page ──────────────────────────────────────────────────────

function scrapeItems($, typeFilter) {
  const items = [];
  const seen = new Set();

  $(`a[href*="/${typeFilter}/"]`).each((_, el) => {
    const $a = $(el);
    const href = ($a.attr('href') || '').split('?')[0].replace(/\/$/, '');
    if (!href.match(/\/(filmes|series)\/[a-z0-9][^/]+$/i)) return;
    const slug = slugFromUrl(href);
    if (!slug || seen.has(slug)) return;

    // The site wraps each item in a parent div.
    // The <img> may be: (a) inside the <a>, (b) in a sibling <div>, or (c) anywhere in the parent.
    const $parent = $a.parent();

    const $img =
      $a.find('img').first().length         ? $a.find('img').first() :
      $a.next('div').find('img').first().length ? $a.next('div').find('img').first() :
      $a.next().find('img').first().length  ? $a.next().find('img').first() :
      $parent.find('img').first();

    const poster =
      $img.attr('src') ||
      $img.attr('data-src') ||
      $img.attr('data-lazy-src') ||
      $img.attr('data-original') || '';

    if (!poster || poster.startsWith('data:')) return;

    const title =
      $parent.find('h3').first().text().trim() ||
      $a.next('h3').text().trim() ||
      $a.siblings('h3').first().text().trim() ||
      $a.attr('title') ||
      $img.attr('alt') ||
      slug.replace(/-/g, ' ');

    if (!title) return;
    seen.add(slug);
    items.push({ href, slug, title, poster });
  });

  return items;
}

// ─── Scrape series detail ─────────────────────────────────────────────────────

async function scrapeSeriesDetail(slug) {
  // Use logged-in Puppeteer — bypasses Cloudflare IP block
  const br = await getBrowser();
  const page = await br.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const rt = req.resourceType();
      if (['image','font','media','stylesheet'].includes(rt)) return req.abort();
      if (['googlesyndication','doubleclick','amazon-adsystem'].some(h => req.url().includes(h))) return req.abort();
      req.continue();
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');

    // Login first — logged-in sessions bypass Cloudflare
    await page.goto('https://osteusfilmestuga.online/a-minha-conta/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const userField = await page.$('#username') || await page.$('input[name="username"]') || await page.$('input[type="email"]');
    const passField = await page.$('#password') || await page.$('input[name="password"]') || await page.$('input[type="password"]');
    if (userField && passField) {
      await userField.type(process.env.WP_USER || '', { delay: 20 });
      await passField.type(process.env.WP_PASS || '', { delay: 20 });
      const btn = await page.$('button[name="login"]') || await page.$('button[type="submit"]');
      if (btn) await Promise.all([btn.click(), page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})]);
    }

    // Now fetch the series page
    await page.goto(seriesUrl(slug), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const data = await page.evaluate(() => {
      const title = document.querySelector('h3.Title,h2.Title,h1.Title,h1,h2,h3')?.textContent?.trim() || '';
      const poster = (document.querySelector('meta[property="og:image"]')?.content || '').trim();
      const desc = Array.from(document.querySelectorAll('p')).find(p => p.textContent.length > 80)?.textContent?.trim() || '';

      // Extract episodes directly from the page - they have data-pid (WP post ID)
      // Structure: <a class="play-ep" data-pid="157987" data-epid="1" data-ssid="1" data-sec="876470b26e">
      const episodes = {};
      document.querySelectorAll('a.play-ep[data-pid]').forEach(a => {
        const pid = a.getAttribute('data-pid');
        const epid = parseInt(a.getAttribute('data-epid'));
        const ssid = parseInt(a.getAttribute('data-ssid'));
        const sec = a.getAttribute('data-sec') || '';
        const thumb = a.querySelector('img')?.src || '';
        const title = a.querySelector('.ep-title')?.textContent?.trim() || 'Episódio ' + epid;
        if (pid && epid && ssid) {
          if (!episodes[ssid]) episodes[ssid] = {};
          episodes[ssid][epid] = { pid, sec, thumb, title };
        }
      });

      // Season counts from the selector
      const seasonCounts = {};
      for (const m of document.body.innerHTML.matchAll(/data-snum=['"](\d+)['"][\s\S]*?\((\d+)\s*Episodes?\)/g)) {
        if (!seasonCounts[parseInt(m[1])]) seasonCounts[parseInt(m[1])] = parseInt(m[2]);
      }

      return { title, poster, desc, episodes, seasonCounts };
    });

    console.log('[series] ' + slug + ' seasons found: ' + Object.keys(data.episodes).length + ' seasonCounts: ' + JSON.stringify(data.seasonCounts));

    const seasons = {};

    // Build seasons from extracted episode data-pids
    for (const [s, eps] of Object.entries(data.episodes)) {
      const sn = parseInt(s);
      seasons[sn] = Object.entries(eps)
        .sort(([a],[b]) => parseInt(a)-parseInt(b))
        .map(([epNum, ep]) => ({
          number: parseInt(epNum),
          title: ep.title,
          thumb: ep.thumb || '',
          pid: ep.pid,
          sec: ep.sec,
        }));
    }

    // Fill in missing seasons from season counts (may need separate page loads)
    for (const [s, cnt] of Object.entries(data.seasonCounts)) {
      const sn = parseInt(s);
      if (!seasons[sn]) {
        seasons[sn] = Array.from({ length: cnt }, (_, i) => ({
          number: i+1, title: 'Episódio '+(i+1), thumb: '', pid: '', sec: '',
        }));
      }
    }

    if (Object.keys(seasons).length === 0) {
      seasons[1] = [{ number: 1, title: 'Episódio 1', thumb: '', pid: '', sec: '' }];
    }

    return { title: data.title || slug, poster: data.poster, background: data.poster, description: data.desc, seasons };
  } catch(e) {
    console.error('[series] error: ' + e.message);
    return { title: slug, poster: '', background: '', description: '', seasons: { 1: [{ number: 1, title: 'Episódio 1', thumb: '', href: '' }] } };
  } finally {
    await page.close().catch(() => {});
  }
}

async function discoverEpisodeSlugLoggedIn(seriesSlug, existingPage) {
  // Use an already-logged-in page to test episode URL guesses
  const guesses = [
    seriesSlug,
    seriesSlug.replace(/^(a|o|os|as|um|uma)-/, ''),
  ];
  const br = await getBrowser();
  const page = await br.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image','font','media','stylesheet','script'].includes(req.resourceType())) return req.abort();
      req.continue();
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    for (const guess of guesses) {
      try {
        await page.goto(BASE + '/episodio/' + guess + '-temporada-1-episodio-1/', { waitUntil: 'domcontentloaded', timeout: 12000 });
        const title = await page.title();
        if (!title.toLowerCase().includes('not found') && !title.includes('404')) {
          console.log('[discoverSlug] found: ' + guess + ' title=' + title);
          return guess;
        }
      } catch(e) { console.log('[discoverSlug] ' + guess + ': ' + e.message); }
    }
  } finally {
    await page.close().catch(() => {});
  }
  return null;
}






// ─── Manifest ────────────────────────────────────────────────────────────────

const manifest = {
  id: 'community.osteusfilmestuga.v4',
  version: '4.0.0',
  name: '🇵🇹 Os Teus Filmes Tuga',
  description: 'Filmes e séries dobrados em Português de Portugal. Streams diretos sem anúncios.',
  logo: LOGO,
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tuga:'],
  catalogs: [
    { type: 'movie',  id: 'tuga_filmes_todos',      name: '🎬 Filmes PT — Todos',   extra: [{ name: 'search', isRequired: false }, { name: 'skip' }] },
    { type: 'movie',  id: 'tuga_filmes_animacao',    name: '🎨 Animação',            extra: [{ name: 'skip' }] },
    { type: 'movie',  id: 'tuga_filmes_familiares',  name: '👨‍👩‍👧 Familiares',         extra: [{ name: 'skip' }] },
    { type: 'movie',  id: 'tuga_filmes_juvenis',     name: '🧒 Juvenis',             extra: [{ name: 'skip' }] },
    { type: 'movie',  id: 'tuga_filmes_liveaction',  name: '🎥 Live Action',         extra: [{ name: 'skip' }] },
    { type: 'movie',  id: 'tuga_filmes_anime',       name: '🌸 Filmes Anime',        extra: [{ name: 'skip' }] },
    { type: 'series', id: 'tuga_series_todas',       name: '📺 Séries PT — Todas',  extra: [{ name: 'search', isRequired: false }, { name: 'skip' }] },
    { type: 'series', id: 'tuga_series_animacao',    name: '🎨 Séries Animação',     extra: [{ name: 'skip' }] },
    { type: 'series', id: 'tuga_series_familiar',    name: '👨‍👩‍👧 Séries Familiares',  extra: [{ name: 'skip' }] },
    { type: 'series', id: 'tuga_series_anime',       name: '🌸 Séries Anime',        extra: [{ name: 'skip' }] },
  ],
};

const CATALOG_URLS = {
  tuga_filmes_todos:      `${BASE}/filmes/`,
  tuga_filmes_animacao:   `${BASE}/genero/filmes-de-animacao/`,
  tuga_filmes_familiares: `${BASE}/genero/filmes-familiares/`,
  tuga_filmes_juvenis:    `${BASE}/genero/filmes-juvenil/`,
  tuga_filmes_liveaction: `${BASE}/genero/filmes-de-live-action/`,
  tuga_filmes_anime:      `${BASE}/genero/filmes-anime/`,
  tuga_series_todas:      `${BASE}/series/`,
  tuga_series_animacao:   `${BASE}/genero/series-de-animacao/`,
  tuga_series_familiar:   `${BASE}/genero/series-familiares-juvenil/`,
  tuga_series_anime:      `${BASE}/genero/series-de-anime/`,
};

const builder = new addonBuilder(manifest);

// ─── Catalog ──────────────────────────────────────────────────────────────────

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    const search = extra && extra.search;
    const skip   = parseInt((extra && extra.skip) || 0);
    const page   = Math.floor(skip / 40) + 1;

    let fetchUrl;
    if (search) {
      const postType = type === 'series' ? 'tvshows' : 'movies';
      fetchUrl = `${BASE}/page/${page}/?s=${encodeURIComponent(search)}&post_type=${postType}`;
    } else {
      const base = CATALOG_URLS[id];
      if (!base) { console.error('[catalog] unknown id:', id); return { metas: [] }; }
      fetchUrl = page === 1 ? base : `${base}page/${page}/`;
    }

    console.log(`[catalog] fetching ${fetchUrl}`);
    let html = '';
    let fetchErr = null;
    // Try plain fetch first (works on Railway), fall back to proxy
    try { html = await get(fetchUrl); } catch(e) {
      fetchErr = e.message;
      try { html = await puppeteerGet(fetchUrl); } catch(e2) { fetchErr = e2.message; }
    }

    if (!html) {
      console.error(`[catalog] empty response for ${fetchUrl} — error: ${fetchErr}`);
      return { metas: [] };
    }

    console.log(`[catalog] got ${html.length} bytes`);

    const $ = cheerio.load(html);

    // Count all anchors for debugging
    const allAnchors = $('a[href*="/filmes/"], a[href*="/series/"]').length;
    console.log(`[catalog] anchors with /filmes/ or /series/: ${allAnchors}`);

    const typeFilter = type === 'series' ? 'series' : 'filmes';
    const items = scrapeItems($, typeFilter);
    console.log(`[catalog] ${id} page=${page} → ${items.length} items scraped`);

    if (items.length === 0) {
      // Log a snippet of the HTML to help debug
      const snippet = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 500);
      console.log(`[catalog] HTML text snippet: ${snippet}`);
    }

    return {
      metas: items.map(item => ({
        id:   type === 'series' ? seriesId(item.slug) : movieId(item.slug),
        type,
        name: item.title,
        poster: item.poster,
        posterShape: 'landscape',
      }))
    };
  } catch (err) {
    console.error('[catalog] unexpected error:', err.message, err.stack);
    return { metas: [] };
  }
});

// ─── Meta ─────────────────────────────────────────────────────────────────────

builder.defineMetaHandler(async ({ type, id }) => {
  try {
    const m = id.match(/^tuga:(movie|series):(.+)$/);
    if (!m) return { meta: null };
    const slug = m[2];

    if (type === 'movie') {
      let html = '';
      try { html = await get(movieUrl(slug)); } catch(e) {
        try { html = await puppeteerGet(movieUrl(slug)); } catch(e2) {}
      }
      const $ = cheerio.load(html);
      const title = $('h3.Title, h2.Title, h1.Title, h1, h2, h3').not('nav *').first().text().trim() || slug;
      const poster = ($('meta[property="og:image"]').attr('content') || '').trim();
      const description = $('.Description p, .sinopse p').first().text().trim()
        || $('p').filter((_, el) => $(el).text().length > 80).first().text().trim();
      const year = $('a[href*="/lancamento/"]').first().text().trim();
      const genres = [];
      $('a[href*="/genero/"]').each((_, el) => { const g = $(el).text().trim(); if (g) genres.push(g); });
      return { meta: { id, type: 'movie', name: title, poster, background: poster, description, releaseInfo: year, genres, website: movieUrl(slug) } };
    }

    if (type === 'series') {
      const detail = await scrapeSeriesDetail(slug);
      const videos = [];
      Object.entries(detail.seasons).forEach(([s, eps]) => {
        eps.forEach(ep => {
          // Format: tuga:series:slug:season:episode[:pid:sec]
          const pidSuffix = ep.pid ? ':' + ep.pid + ':' + (ep.sec || '') : '';
          videos.push({
            id: `${id}:${s}:${ep.number}${pidSuffix}`,
            title: ep.title, season: parseInt(s), episode: ep.number,
            thumbnail: ep.thumb || detail.poster, released: ep.date || '',
          });
        });
      });
      return { meta: { id, type: 'series', name: detail.title, poster: detail.poster, background: detail.background, description: detail.description, videos, website: seriesUrl(slug) } };
    }

    return { meta: null };
  } catch (err) {
    console.error('[meta] ERROR:', err.message, err.stack);
    return { meta: null };
  }
});

// ─── Stream ───────────────────────────────────────────────────────────────────

builder.defineStreamHandler(async ({ type, id }) => {
  try {
    let pageUrl;
    if (type === 'movie') {
      const m = id.match(/^tuga:movie:(.+)$/);
      if (!m) return { streams: [] };
      pageUrl = movieUrl(m[1]);
    } else {
      // ID format: tuga:series:slug:season:episode or tuga:series:slug:season:episode:pid:sec
      const m = id.match(/^tuga:series:(.+):(\d+):(\d+)(?::(\d+):([a-z0-9]*))?$/);
      if (!m) return { streams: [] };
      if (m[4]) {
        // Have the WP post ID — use admin-ajax method directly
        const pid = m[4];
        const sec = m[5] || '';
        console.log('[stream] using pid=' + pid + ' sec=' + sec);
        return { streams: await extractStreamsForEpisode(pid, sec) };
      } else {
        // No pid stored, fall back to page URL discovery
        const epSlug = await discoverEpisodeSlugLoggedIn(m[1], null).catch(() => null) || m[1];
        pageUrl = BASE + '/episodio/' + epSlug + '-temporada-' + m[2] + '-episodio-' + m[3] + '/';
        console.log('[stream] fallback episode URL: ' + pageUrl);
      }
    }

    console.log(`[stream] extracting from ${pageUrl}`);
    const streams = await extractStreams(pageUrl);
    console.log(`[stream] returning ${streams.length} streams`);
    return { streams };
  } catch (err) {
    console.error('[stream]', err.message);
    return { streams: [{ title: '🌐 Abrir no browser', externalUrl: BASE }] };
  }
});

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();

// getRouter() from SDK returns a router with CORS already included
const addonRouter = getRouter(builder.getInterface());
app.use('/', addonRouter);

// Debug: test series meta scraping
app.get('/debug-meta', async (req, res) => {
  const slug = req.query.slug || 'a-navegante-da-lua';
  const br = await getBrowser();
  const page = await br.newPage();
  const ajaxResponses = [];
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url(), rt = req.resourceType();
      if (['image','font','media','stylesheet'].includes(rt)) return req.abort();
      if (['googlesyndication','doubleclick'].some(h => u.includes(h))) return req.abort();
      req.continue();
    });
    // Intercept ALL admin-ajax responses
    page.on('response', async resp => {
      const u = resp.url();
      if (u.includes('admin-ajax') || u.includes('zetaflix') || u.includes('episodio')) {
        try {
          const text = await resp.text().catch(() => '');
          ajaxResponses.push({ url: u, status: resp.status(), body: text.slice(0, 2000) });
        } catch {}
      }
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');

    // Login
    await page.goto('https://osteusfilmestuga.online/a-minha-conta/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const uf = await page.$('#username') || await page.$('input[name="username"]') || await page.$('input[type="email"]');
    const pf = await page.$('#password') || await page.$('input[name="password"]') || await page.$('input[type="password"]');
    if (uf && pf) {
      await uf.type(process.env.WP_USER || '', { delay: 20 });
      await pf.type(process.env.WP_PASS || '', { delay: 20 });
      const btn = await page.$('button[name="login"]') || await page.$('button[type="submit"]');
      if (btn) await Promise.all([btn.click(), page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})]);
    }

    // Navigate to series page
    await page.goto(BASE + '/series/' + slug + '/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // Get post ID and nonce from the page
    const pageData = await page.evaluate(() => {
      const postId = document.querySelector('[data-post]')?.getAttribute('data-post')
        || document.querySelector('[id*="post-"]')?.id?.match(/\d+/)?.[0]
        || '';
      const nonce = (document.body.innerHTML.match(/"nonce"\s*:\s*"([^"]+)"/) || [])[1] || '';
      const ajaxUrl = (document.body.innerHTML.match(/ajaxurl\s*[=:]\s*["']([^"']+)["']/) || [])[1] || '/wp-admin/admin-ajax.php';
      // Try to find series post ID
      const seriesId = (document.body.innerHTML.match(/["']post_id["']\s*:\s*(\d+)/) || [])[1]
        || (document.body.innerHTML.match(/data-id=["'](\d+)["']/) || [])[1] || '';
      return { postId, nonce, ajaxUrl, seriesId };
    });

    // Try calling admin-ajax with zetapostlinks action
    const ajaxResult = await page.evaluate(async (data) => {
      const formData = new FormData();
      formData.append('action', 'zetapostlinks');
      formData.append('post_id', data.seriesId || data.postId || '');
      formData.append('season', '1');
      formData.append('nonce', data.nonce || '');
      try {
        const resp = await fetch('/wp-admin/admin-ajax.php', { method: 'POST', body: formData, credentials: 'include' });
        const text = await resp.text();
        return { status: resp.status, body: text.slice(0, 2000) };
      } catch(e) { return { error: e.message }; }
    }, pageData);

    // Click season tab and wait for ajax-episode div to fill
    await page.evaluate(() => {
      const tab = document.querySelector('.seasons-list li:first-child a, li.ss-1 a');
      if (tab) tab.click();
    });
    await new Promise(r => setTimeout(r, 5000));

    const ajaxEpisodeHtml = await page.evaluate(() =>
      document.querySelector('.ajax-episode')?.innerHTML?.slice(0, 2000) || 'empty'
    );
    const epLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="/episodio/"]')).map(a => a.href).slice(0, 5)
    );

    res.json({ slug, pageData, ajaxResult, ajaxResponses, ajaxEpisodeHtml, epLinks });
  } catch(e) {
    res.json({ slug, error: e.message, ajaxResponses });
  } finally {
    await page.close().catch(() => {});
  }
});

app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Debug: test stream extraction for a URL
app.get('/debug-stream', async (req, res) => {
  // Uses the full Puppeteer login flow — same as extractStreams
  const url = req.query.url || `${BASE}/filmes/david/`;
  const br = await getBrowser();
  const page = await br.newPage();
  const debug = { url, loginUrl: null, loggedIn: false, apiResponses: [], iframes: [], streams: [], error: null };

  try {
    await page.setRequestInterception(true);
    page.on('response', async resp => {
      const u = resp.url();
      if (u.includes('zetaplayer') || (u.includes('admin-ajax') && !u.includes('counting'))) {
        const text = await resp.text().catch(() => '');
        debug.apiResponses.push({ url: u, status: resp.status(), body: text.slice(0, 500) });
      }
    });
    page.on('request', req => {
      const u = req.url();
      const rt = req.resourceType();
      // Block ads and binary media only — allow ALL scripts so zetaplayer works
      if (['image', 'font', 'media'].includes(rt)) return req.abort();
      if (['googlesyndication','doubleclick','amazon-adsystem','taboola','outbrain','variationconfused','hotjar','clarity.ms'].some(h => u.includes(h))) return req.abort();
      req.continue();
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');

    // Login via WooCommerce My Account page
    await page.goto('https://osteusfilmestuga.online/a-minha-conta/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Try all possible login field selectors
    const userField = await page.$('#username')
      || await page.$('input[name="username"]')
      || await page.$('input[name="email"]')
      || await page.$('input[type="email"]')
      || await page.$('#user_login')
      || await page.$('input[autocomplete="username"]')
      || await page.$('input[autocomplete="email"]');
    const passField = await page.$('#password')
      || await page.$('input[name="password"]')
      || await page.$('#user_pass')
      || await page.$('input[type="password"]')
      || await page.$('input[autocomplete="current-password"]');
    debug.loginFieldsFound = { user: !!userField, pass: !!passField };
    if (userField && passField) {
      await userField.click({ clickCount: 3 });
      await userField.type(process.env.WP_USER || 'toffoarancia@googlemail.com', { delay: 30 });
      await passField.click({ clickCount: 3 });
      await passField.type(process.env.WP_PASS || '60Toffo60!', { delay: 30 });
      const submitBtn = await page.$('button[name="login"]') || await page.$('input[type="submit"]') || await page.$('button[type="submit"]');
      if (submitBtn) {
        await Promise.all([
          submitBtn.click(),
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        ]);
      }
    }
    debug.loginUrl = page.url();
    debug.loggedIn = !debug.loginUrl.includes('a-minha-conta') || debug.loginUrl.includes('conta') && !debug.loginUrl.includes('action=login');

    // Navigate to page
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    // Wait for player tabs - episode pages load them via AJAX
    try { await page.waitForSelector('li.zetaflix_player_option', { timeout: 8000 }); } catch(e) {}

    // Click each player tab using JS dispatchEvent
    const tabCount2 = await page.evaluate(() =>
      document.querySelectorAll('li.zetaflix_player_option').length
    );
    debug.tabsFound = tabCount2;
    for (let i = 0; i < Math.min(tabCount2, 3); i++) {
      await page.evaluate((idx) => {
        const tabs = document.querySelectorAll('li.zetaflix_player_option');
        if (tabs[idx]) tabs[idx].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }, i);
      await new Promise(r => setTimeout(r, 8000));
    }

    // Read iframes
    debug.iframes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, id: f.id, cls: f.className }))
    );

    // Dump all li elements to see what's on the page
    debug.allLis = await page.evaluate(() =>
      Array.from(document.querySelectorAll('li')).map(li => ({
        text: li.textContent.trim().slice(0, 40),
        cls: li.className,
        id: li.id,
        onclick: li.getAttribute('onclick'),
        dataPost: li.getAttribute('data-post'),
        dataType: li.getAttribute('data-type'),
        dataNume: li.getAttribute('data-nume'),
      })).filter(li => li.dataPost || li.cls.includes('player') || li.cls.includes('zetaflix'))
    );

    // Also dump page title to confirm we're on the right page
    debug.pageTitle = await page.title();
    debug.currentUrl = page.url();

    // Run full stream extraction
    debug.streams = await extractStreams(url);
  } catch(e) {
    debug.error = e.message;
  } finally {
    await page.close().catch(() => {});
  }
  res.json(debug);
});

app.get('/debug-puppeteer', async (req, res) => {
  const url = req.query.url || `${BASE}/filmes/david/`;
  const br = await getBrowser();
  const page = await br.newPage();
  const log = { url, requests: [], iframesAfterClick: [], domSnippet: '', error: null };
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      const rt = req.resourceType();
      // Block ads and binary media only — allow ALL scripts so zetaplayer works
      if (['image', 'font', 'media'].includes(rt)) return req.abort();
      if (['googlesyndication','doubleclick','amazon-adsystem','taboola','outbrain','variationconfused','hotjar','clarity.ms'].some(h => u.includes(h))) return req.abort();
      req.continue();
    });
    page.on('response', async resp => {
      const u = resp.url();
      if (u.includes('zetaplayer') || u.includes('admin-ajax') || u.includes('wp-json/zetaplayer')) {
        const text = await resp.text().catch(() => '');
        log.requests.push({ url: u, status: resp.status(), body: text.slice(0, 1000) });
      }
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // Read ALL iframes before clicking
    log.iframesBefore = await page.evaluate(() =>
      Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, id: f.id, cls: f.className }))
    );

    // Find and click player tabs
    const tabs = await page.$$('li.zetaflix_player_option');
    log.tabsFound = tabs.length;

    // Also try alternative selectors
    const altTabs = await page.$$('#playeroptionsul li');
    log.altTabsFound = altTabs.length;

    // Get tab HTML
    log.tabsHTML = await page.evaluate(() => {
      const ul = document.querySelector('#playeroptionsul, .player-options, [id*="player"]');
      return ul ? ul.outerHTML.slice(0, 500) : 'NOT FOUND';
    });

    // Click first tab
    if (tabs.length > 0) {
      await tabs[0].click();
      await new Promise(r => setTimeout(r, 4000));
      log.iframesAfterClick = await page.evaluate(() =>
        Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, id: f.id, cls: f.className }))
      );
    } else if (altTabs.length > 0) {
      await altTabs[0].click();
      await new Promise(r => setTimeout(r, 4000));
      log.iframesAfterClick = await page.evaluate(() =>
        Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, id: f.id, cls: f.className }))
      );
    }

    // Get ztAjax config from page
    log.ztAjax = await page.evaluate(() => {
      return typeof ztAjax !== 'undefined' ? ztAjax : 'NOT DEFINED';
    }).catch(() => 'ERROR');

    // Get any XHR made (via performance entries)
    log.networkEntries = await page.evaluate(() => {
      return performance.getEntriesByType('resource')
        .filter(e => e.initiatorType === 'xmlhttprequest' || e.initiatorType === 'fetch')
        .map(e => ({ url: e.name, duration: Math.round(e.duration) }));
    }).catch(() => []);

  } catch(e) {
    log.error = e.message;
  } finally {
    await page.close().catch(()=>{});
  }
  res.json(log);
});

// Debug: dump DOM info after page loads — helps identify player tab selectors
app.get('/debug-dom', async (req, res) => {
  const url = req.query.url || `${BASE}/filmes/david/`;
  const br = await getBrowser();
  const page = await br.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      const rt = req.resourceType();
      // Block ads and binary media only — allow ALL scripts so zetaplayer works
      if (['image', 'font', 'media'].includes(rt)) return req.abort();
      if (['googlesyndication','doubleclick','amazon-adsystem','taboola','outbrain','variationconfused','hotjar','clarity.ms'].some(h => u.includes(h))) return req.abort();
      req.continue();
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    const info = await page.evaluate(() => {
      // Dump all iframes
      const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({
        src: f.src, id: f.id, cls: f.className
      }));

      // Dump all li elements that might be player tabs
      const lis = Array.from(document.querySelectorAll('li')).map(li => ({
        text: li.textContent.trim().slice(0, 50),
        onclick: li.getAttribute('onclick'),
        cls: li.className,
        id: li.id,
        parentCls: li.parentElement ? li.parentElement.className : '',
      })).filter(li => li.text.length > 0 && li.text.length < 60);

      // Dump all elements with onclick
      const onclicks = Array.from(document.querySelectorAll('[onclick]')).map(el => ({
        tag: el.tagName, text: el.textContent.trim().slice(0, 50),
        onclick: el.getAttribute('onclick'), cls: el.className
      }));

      // Dump all script inline content snippets that mention iframe or player
      const scripts = Array.from(document.querySelectorAll('script:not([src])')).map(s => {
        const t = s.textContent;
        if (t.includes('iframe') || t.includes('player') || t.includes('Player') || t.includes('metaframe')) {
          return t.slice(0, 500);
        }
        return null;
      }).filter(Boolean);

      return { iframes, lis: lis.slice(0, 30), onclicks, scripts: scripts.slice(0, 5) };
    });

    res.json({ url, ...info });
  } catch(e) {
    res.json({ url, error: e.message });
  } finally {
    await page.close().catch(()=>{});
  }
});

// Debug: test catalog scraping and show exactly what's happening
app.get('/debug-catalog', async (req, res) => {
  const url = req.query.url || `${BASE}/filmes/`;
  const result = { url, htmlLength: 0, anchorCount: 0, itemCount: 0, items: [], error: null, htmlSnippet: '' };
  try {
    const html = await get(url);
    result.htmlLength = html.length;
    const $ = cheerio.load(html);
    const typeFilter = url.includes('/series') ? 'series' : 'filmes';
    result.anchorCount = $(`a[href*="/${typeFilter}/"]`).length;
    const items = scrapeItems($, typeFilter);
    result.itemCount = items.length;
    result.items = items.slice(0, 10);
    // Show raw anchor samples
    result.anchorSamples = [];
    $(`a[href*="/${typeFilter}/"]`).slice(0, 5).each((_, el) => {
      result.anchorSamples.push({
        href: $(el).attr('href'),
        hasImg: $(el).find('img').length > 0,
        imgSrc: $(el).find('img').first().attr('src') || '',
        nextTag: $(el).next()[0] && $(el).next()[0].name,
        nextText: $(el).next().text().trim().slice(0, 60),
      });
    });
    // Raw text snippet
    result.htmlSnippet = html.slice(html.indexOf('/filmes/') > 0 ? html.indexOf('/filmes/') - 100 : 0, html.indexOf('/filmes/') + 400);
  } catch (e) {
    result.error = e.message;
  }
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`\n🇵🇹 Os Teus Filmes Tuga — Addon v4 (Puppeteer)`);
  console.log(`   Port    : ${PORT}`);
  console.log(`   Manifest: http://localhost:${PORT}/manifest.json`);
  console.log(`   Debug   : http://localhost:${PORT}/debug-catalog`);
  console.log(`   Debug   : http://localhost:${PORT}/debug-stream?url=https://osteusfilmestuga.online/filmes/david/\n`);

  // Pre-warm browser
  getBrowser().then(() => console.log('   Browser : ready ✅')).catch(e => console.error('   Browser : failed ❌', e.message));
});
