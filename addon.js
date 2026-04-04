'use strict';

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-core');

const BASE = 'https://osteusfilmestuga.online';
const ADDON_URL = process.env.ADDON_URL || 'https://stremio-tuga-production.up.railway.app';
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
      await Promise.all([
        page.evaluate(() => { const b = document.querySelector('button[name="login"]') || document.querySelector('button[type="submit"]'); if (b) b.click(); }),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
      ]);
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
          const m = data.embed_url.match(/(?:src|SRC)=["']([^"'<>\s]+)/i);
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
  // Login, get nonce from page, call zetaplayer API directly, then get .m3u8 from embed
  const streams = [];
  const seen = new Set();
  function addStream(s) {
    const key = s.url || s.externalUrl || '';
    if (key && !seen.has(key)) { seen.add(key); streams.push(s); }
  }

  const br = await getBrowser();
  const page = await br.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url(), rt = req.resourceType();
      if (['image','font','media'].includes(rt)) return req.abort();
      if (['googlesyndication','doubleclick','amazon-adsystem'].some(h => u.includes(h))) return req.abort();
      req.continue();
    });
    // Capture direct video URLs
    page.on('response', resp => {
      if (resp.url().match(/\.(?:mp4|m3u8)(\?|$)/i)) addStream({ title: '▶ Direto PT', url: resp.url() });
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');

    // Login using page.evaluate (more reliable than Puppeteer selectors)
    await page.goto('https://osteusfilmestuga.online/a-minha-conta/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.evaluate(async (user, pass) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const userInput = inputs.find(i => i.type === 'text' || i.type === 'email' || i.name === 'username' || i.id === 'username');
      const passInput = inputs.find(i => i.type === 'password');
      if (!userInput || !passInput) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(userInput, user);
      userInput.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(passInput, pass);
      passInput.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = document.querySelector('button[name="login"]') || document.querySelector('button[type="submit"]') || document.querySelector('input[type="submit"]');
      if (btn) btn.click();
    }, process.env.WP_USER || '', process.env.WP_PASS || '');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    // If still on login page, try submitting the form directly
    const stillOnLogin = page.url().includes('a-minha-conta');
    if (stillOnLogin) {
      await page.evaluate((user, pass) => {
        const form = document.querySelector('form.woocommerce-form-login, form[method="post"]');
        if (!form) return;
        const inputs = Array.from(form.querySelectorAll('input'));
        const userInput = inputs.find(i => i.type !== 'hidden' && i.type !== 'submit' && i.type !== 'checkbox');
        const passInput = inputs.find(i => i.type === 'password');
        if (userInput) userInput.value = user;
        if (passInput) passInput.value = pass;
        form.submit();
      }, process.env.WP_USER || '', process.env.WP_PASS || '');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
    console.log('[streams] logged in, url=' + page.url());

    // Navigate to content page and get player options + nonce
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const pageInfo = await page.evaluate(() => {
      const nonce = (document.body.innerHTML.match(/"nonce"\s*:\s*"([a-f0-9]+)"/) || [])[1] || '';
      const tabs = Array.from(document.querySelectorAll('li.zetaflix_player_option')).map(li => ({
        postId: li.getAttribute('data-post'),
        type: li.getAttribute('data-type') || 'mv',
        nume: li.getAttribute('data-nume'),
      })).filter(t => t.postId && t.nume);
      return { nonce, tabs };
    });
    console.log('[streams] tabs=' + pageInfo.tabs.length + ' nonce=' + pageInfo.nonce);

    // Call zetaplayer API for each tab using fetch with credentials
    for (let i = 0; i < Math.min(pageInfo.tabs.length, 3); i++) {
      const tab = pageInfo.tabs[i];
      const apiUrl = '/wp-json/zetaplayer/v2/' + tab.postId + '/' + tab.type + '/' + tab.nume;
      try {
        const result = await page.evaluate(async (apiUrl, nonce) => {
          const resp = await fetch(apiUrl, { credentials: 'include' });
          return await resp.text();
        }, apiUrl, pageInfo.nonce);

        const data = JSON.parse(result);
        console.log('[streams] tab ' + (i+1) + ' embed_url=' + data.embed_url?.slice(0, 80));

        if (data.embed_url) {
          const m = data.embed_url.match(/(?:src|SRC)=["']([^"'<>\s]+)/i);
          if (m && m[1].startsWith('http')) {
            const embedUrl = m[1];
            const host = (() => { try { return new URL(embedUrl).hostname.replace('www.',''); } catch { return ''; } })();
            // Try live-stream proxy for all players
            const liveUrl = ADDON_URL + '/live-stream?embed=' + encodeURIComponent(embedUrl);
            addStream({ title: '▶ Player ' + (i+1) + ' PT', url: liveUrl });
            // Also add embed as external option
            addStream({ title: '🔗 Player ' + (i+1) + ' (' + host + ')', externalUrl: embedUrl });
          }
        }
      } catch(e) {
        console.log('[streams] tab ' + (i+1) + ' error: ' + e.message);
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
  let resolved = false;

  return new Promise(async (resolve) => {
    const done = (result) => {
      if (!resolved) {
        resolved = true;
        page.close().catch(() => {});
        resolve(result);
      }
    };

    setTimeout(() => done(null), 25000);

    try {
      await page.setRequestInterception(true);
      let firstMasterUrl = null;

      page.on('request', req => {
        const u = req.url();
        const rt = req.resourceType();
        if (['image', 'font', 'media'].includes(rt)) return req.abort();
        const blockList = ['tiktokcdn', 'tiktok.com', 'googlesyndication', 'doubleclick',
          'amazon-adsystem', 'imasdk.googleapis', 'googleads', 'adnxs', 'yandex', 'mc.yandex'];
        if (blockList.some(h => u.includes(h))) return req.abort();
        if (u.includes('minochinos.com/ad') || u.includes('minochinos.com/assets/jquery/static.js')) return req.abort();
        if (!u.includes('minochinos.com') && (u.includes('.m3u8') || u.includes('.mp4'))) {
          console.log('[directVideo] non-minochinos stream: ' + u.slice(-60));
          done({ url: u, referer: req.headers()['referer'] || playerUrl });
          return;
        }
        if (u.includes('minochinos.com') && u.includes('master.m3u8') && !firstMasterUrl) {
          firstMasterUrl = u;
        }
        req.continue();
      });

      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
      await page.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, 2000));

      await page.evaluate(() => {
        try {
          if (typeof jwplayer !== 'undefined') {
            const p = jwplayer();
            if (p.skipAd) p.skipAd();
            if (p.setConfig) p.setConfig({ advertising: null });
            if (p.play) p.play();
          }
        } catch(e) {}
      }).catch(() => {});

      await new Promise(r => setTimeout(r, 3000));

      const jwUrl = await page.evaluate(() => {
        try {
          if (typeof jwplayer === 'undefined') return null;
          const p = jwplayer();
          const pl = p.getPlaylist ? p.getPlaylist() : [];
          if (pl[0] && pl[0].file) {
            const f = pl[0].file;
            return f.startsWith('http') ? f : 'https://minochinos.com' + f;
          }
        } catch(e) {}
        return null;
      }).catch(() => null);

      if (jwUrl) {
        console.log('[directVideo] JWPlayer URL: ' + jwUrl.slice(-60));
        done({ url: jwUrl, referer: playerUrl });
        return;
      }

      if (firstMasterUrl) {
        done({ url: firstMasterUrl, referer: playerUrl });
        return;
      }

      done(null);
    } catch(e) {
      console.error('[directVideo] error: ' + e.message);
      done(null);
    }
  });
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

// ─── Caches ───────────────────────────────────────────────────────────────────
const seriesCache = new Map(); // slug -> { data, ts }
const SERIES_CACHE_TTL = 60 * 60 * 1000; // 1 hour

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

async function discoverEpisodeSlug(seriesSlug) {
  const guesses = [
    seriesSlug,
    seriesSlug.replace(/^(a|o|os|as|um|uma)-/, ''),
  ];
  for (const guess of guesses) {
    try {
      const html = await get(BASE + '/episodio/' + guess + '-temporada-1-episodio-1/');
      if (html.length > 5000 && !html.includes('Page Not Found')) {
        console.log('[discoverSlug] found: ' + guess);
        return guess;
      }
    } catch(e) {}
  }
  return null;
}

async function scrapeSeriesDetail(slug) {
  // Fast path: plain fetch (works on Railway since site doesn't block it)
  // Falls back to logged-in Puppeteer if blocked
  let html = '';
  try {
    html = await get(seriesUrl(slug));
    if (html.length < 5000) throw new Error('too short');
  } catch(e) {
    console.log('[series] plain fetch failed, trying Puppeteer login: ' + e.message);
    html = await scrapeSeriesWithPuppeteer(slug);
    const $ = cheerio.load(html || '');
    return buildSeriesDetail(slug, $, html || '');
  }

  const $ = cheerio.load(html);
  return buildSeriesDetail(slug, $, html);
}

function buildSeriesDetail(slug, $, html) {
  const title = $('h3.Title,h2.Title,h1.Title,h1,h2,h3').not('nav *').first().text().trim() || slug;
  const poster = ($('meta[property="og:image"]').attr('content') || '').trim();
  const description = $('.Description p,.sinopse p').first().text().trim()
    || $('p').filter((_, el) => $(el).text().length > 80).first().text().trim();

  const seasons = {};
  for (const m of html.matchAll(/data-snum=['"](\d+)['"][\s\S]*?\((\d+)\s*Episodes?\)/g)) {
    const sn = parseInt(m[1]), cnt = parseInt(m[2]);
    if (!seasons[sn]) seasons[sn] = Array.from({ length: cnt }, (_, i) => ({
      number: i+1, title: 'Episódio '+(i+1), thumb: '', href: '', date: '',
    }));
  }
  // Fallback plain text
  if (Object.keys(seasons).length === 0) {
    for (const m of html.matchAll(/Temporada\s+(\d+)\s*\((\d+)/gi)) {
      const sn = parseInt(m[1]), cnt = parseInt(m[2]);
      if (!seasons[sn]) seasons[sn] = Array.from({ length: cnt }, (_, i) => ({
        number: i+1, title: 'Episódio '+(i+1), thumb: '', href: '', date: '',
      }));
    }
  }
  // Episode thumbs
  $('li').each((_, li) => {
    const $li = $(li);
    const num = parseInt($li.contents().filter((_, n) => n.nodeType === 3).first().text().trim());
    const thumb = $li.find('img').first().attr('src') || '';
    if (num && thumb && seasons[1] && seasons[1][num-1]) seasons[1][num-1].thumb = thumb;
  });
  if (Object.keys(seasons).length === 0) {
    seasons[1] = [{ number: 1, title: 'Episódio 1', thumb: '', href: '', date: '' }];
  }

  // Try to find episode slug from any episodio links in the HTML
  const epLinkMatch = html.match(/href=["'][^"']*\/episodio\/([^"'\/]+)-temporada-/i);
  const episodeSlug = epLinkMatch ? epLinkMatch[1] : null;
  console.log('[series] ' + slug + ' episodeSlug=' + episodeSlug + ' seasons=' + Object.keys(seasons).join(','));

  if (episodeSlug) {
    for (const [s, eps] of Object.entries(seasons))
      for (const ep of eps)
        ep.href = BASE + '/episodio/' + episodeSlug + '-temporada-' + s + '-episodio-' + ep.number + '/';
  }

  return { title, poster, background: poster, description, seasons };
}

async function scrapeSeriesWithPuppeteer(slug) {
  // Logged-in Puppeteer for when plain fetch is blocked
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
    await page.goto('https://osteusfilmestuga.online/a-minha-conta/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const uf = await page.$('#username') || await page.$('input[name="username"]') || await page.$('input[type="email"]');
    const pf = await page.$('#password') || await page.$('input[name="password"]') || await page.$('input[type="password"]');
    if (uf && pf) {
      await uf.type(process.env.WP_USER || '', { delay: 20 });
      await pf.type(process.env.WP_PASS || '', { delay: 20 });
      await Promise.all([
        page.evaluate(() => { const b = document.querySelector('button[name="login"]') || document.querySelector('button[type="submit"]'); if (b) b.click(); }),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
      ]);
    }
    await page.goto(seriesUrl(slug), { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    return await page.content();
  } finally {
    await page.close().catch(() => {});
  }
}




// ─── Manifest ────────────────────────────────────────────────────────────────

const manifest = {
  id: 'community.osteusfilmestuga.v4',
  version: '4.1.0',
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
      // Try multiple poster sources
      const poster = ($('meta[property="og:image"]').attr('content') || '').trim()
        || $('img[src*="tmdb.org"]').first().attr('src') || ''
        || $('img[src*="image.tmdb"]').first().attr('src') || '';
      const description = $('.Description p, .sinopse p').first().text().trim()
        || $('p').filter((_, el) => $(el).text().length > 80).first().text().trim();
      const year = $('a[href*="/lancamento/"]').first().text().trim();
      const genres = [];
      $('a[href*="/genero/"]').each((_, el) => { const g = $(el).text().trim(); if (g) genres.push(g); });
      return { meta: { id, type: 'movie', name: title, poster, background: poster, description, releaseInfo: year, genres, website: movieUrl(slug) } };
    }

    if (type === 'series') {
      // Check cache first
      let detail;
      const cached = seriesCache.get(slug);
      if (cached && Date.now() - cached.ts < SERIES_CACHE_TTL) {
        console.log('[meta] cache hit: ' + slug);
        detail = cached.data;
      } else {
        // Add timeout so Stremio doesn't hang forever
        detail = await Promise.race([
          scrapeSeriesDetail(slug),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 55000)),
        ]).catch(e => {
          console.error('[meta] series detail error/timeout: ' + e.message);
          return cached?.data || { title: slug, poster: '', background: '', description: '', seasons: {} };
        });
        seriesCache.set(slug, { data: detail, ts: Date.now() });
      }
      const videos = [];
      Object.entries(detail.seasons).forEach(([s, eps]) => {
        eps.forEach(ep => {
          const pidSuffix = ep.pid ? ':' + ep.pid + ':' + (ep.sec || '') : '';
          videos.push({
            id: `${id}:${s}:${ep.number}${pidSuffix}`,
            title: ep.title, season: parseInt(s), episode: ep.number,
            thumbnail: ep.thumb || detail.poster, released: ep.date || '',
          });
        });
      });
      return { meta: { id, type: 'series', name: detail.title || slug, poster: detail.poster, background: detail.background, description: detail.description, videos, website: seriesUrl(slug) } };
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
        const epSlug = await discoverEpisodeSlug(m[1]).catch(() => null) || m[1];
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
      await Promise.all([
        page.evaluate(() => { const b = document.querySelector('button[name="login"]') || document.querySelector('button[type="submit"]'); if (b) b.click(); }),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
      ]);
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

app.get('/test-catalog', async (req, res) => {
  try {
    const html = await get(`${BASE}/filmes/`);
    const $ = cheerio.load(html);
    const items = scrapeItems($, 'filmes');
    res.json({ htmlLength: html.length, itemCount: items.length, first: items[0] || null });
  } catch(e) {
    res.json({ error: e.message });
  }
});



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
      await page.evaluate((u, p) => {
        if (u) { u.value = ''; u.focus(); }
      }, userField, passField).catch(() => {});
      await userField.type(process.env.WP_USER || 'toffoarancia@googlemail.com', { delay: 30 });
      await passField.type(process.env.WP_PASS || '60Toffo60!', { delay: 30 });
      await Promise.all([
        page.evaluate(() => {
          const btn = document.querySelector('button[name="login"]') || document.querySelector('input[type="submit"]') || document.querySelector('button[type="submit"]');
          if (btn) btn.click();
        }),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
      ]);
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

    // Extract streams directly from already-captured API responses
    // (don't call extractStreams again — it would open a new login session)
    const directStreams = [];
    for (const resp of debug.apiResponses) {
      if (!resp.url.includes('zetaplayer')) continue;
      try {
        const data = JSON.parse(resp.body);
        debug._parsed = debug._parsed || [];
        debug._parsed.push({ embed_url: data.embed_url });
        if (data.embed_url) {
          const m = data.embed_url.match(/(?:src|SRC)=["']([^"'<>\s]+)/i);
          debug._parsed[debug._parsed.length-1].matched = m ? m[1] : 'NO MATCH';
          if (m && m[1].startsWith('http')) {
            const embedUrl = m[1];
            // Try extractDirectVideo but don't block on failure
            let direct = null;
            try {
              direct = await Promise.race([
                extractDirectVideo(embedUrl),
                new Promise(r => setTimeout(() => r(null), 15000))
              ]);
            } catch(e) { debug._parsed[debug._parsed.length-1].extractError = e.message; }

            if (direct) {
              directStreams.push({ title: '▶ PT (direto)', url: direct });
            } else {
              // Return embed URL directly — Stremio can open it
              try {
                const host = new URL(embedUrl).hostname.replace('www.', '');
                directStreams.push({ title: '▶ Player (' + host + ')', externalUrl: embedUrl });
              } catch {}
            }
          }
        }
      } catch(e) { console.log('[debug-stream] parse error: ' + e.message); }
    }
    directStreams.push({ title: '🌐 Abrir no browser', externalUrl: url });
    debug.streams = directStreams;
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

app.get('/test-player2', async (req, res) => {
  const embedUrl = req.query.embed;
  if (!embedUrl) return res.json({ error: 'Pass ?embed=URL' });
  try {
    const result = await extractDirectVideo(embedUrl);
    res.json({ embedUrl, result });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get('/test-embed', async (req, res) => {
  const embedUrl = req.query.embed || 'https://minochinos.com/embed/4u1yo63ktzoj';
  try {
    const result = await extractDirectVideo(embedUrl);
    if (!result) return res.json({ error: 'No stream found' });
    const childUrl = result.url.replace('master.m3u8', 'index-v1-a1.m3u8');
    // Poll child m3u8 every 5s for 60s to see when/if it switches to real content
    const polls = [];
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, i === 0 ? 0 : 5000));
      try {
        const r = await fetch(childUrl, { headers: { 'Referer': result.referer, 'User-Agent': 'Mozilla/5.0' } });
        const t = await r.text();
        const firstSeg = t.split('\n').find(l => l.trim() && !l.startsWith('#')) || '';
        polls.push({ t: i * 5 + 's', isAd: firstSeg.includes('tiktokcdn'), firstSeg: firstSeg.slice(0, 80) });
        if (!firstSeg.includes('tiktokcdn')) break; // real content found!
      } catch(e) { polls.push({ t: i * 5 + 's', error: e.message }); }
    }
    res.json({ streamUrl: result.url, childUrl, polls });
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.get('/test-player2', async (req, res) => {
  const slug = req.query.slug || 'david';
  const pageUrl = `${BASE}/filmes/${slug}/`;
  const br = await getBrowser();
  const page = await br.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url(), rt = req.resourceType();
      if (['image','font','media'].includes(rt)) return req.abort();
      req.continue();
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    await page.goto('https://osteusfilmestuga.online/a-minha-conta/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.evaluate(async (user, pass) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const u = inputs.find(i => i.name === 'username' || i.name === 'log' || i.type === 'text' || i.type === 'email');
      const p = inputs.find(i => i.type === 'password');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      if (u) { setter.call(u, user); u.dispatchEvent(new Event('input', { bubbles: true })); }
      if (p) { setter.call(p, pass); p.dispatchEvent(new Event('input', { bubbles: true })); }
      const btn = document.querySelector('button[name="login"],button[type="submit"]');
      if (btn) btn.click();
    }, process.env.WP_USER, process.env.WP_PASS);
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise(r => setTimeout(r, 2000));

    const tabs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[data-post][data-nume]')).map(li => ({
        postId: li.getAttribute('data-post'),
        type: li.getAttribute('data-type') || 'mv',
        nume: li.getAttribute('data-nume'),
      }));
    });

    const results = [];
    for (const tab of tabs.slice(0, 3)) {
      const apiUrl = `/wp-json/zetaplayer/v2/${tab.postId}/${tab.type}/${tab.nume}`;
      const raw = await page.evaluate(async (url) => {
        const r = await fetch(url, { credentials: 'include' });
        return await r.text();
      }, apiUrl).catch(e => e.message);
      let embedUrl = null;
      try {
        const data = JSON.parse(raw);
        const m = data.embed_url?.match(/(?:src|SRC)=["']([^"'<>\s]+)/i);
        embedUrl = m ? m[1] : data.embed_url;
      } catch(e) {}
      results.push({ nume: tab.nume, embedUrl, raw: raw?.slice(0, 200) });
    }
    res.json({ pageUrl, tabs, results });
  } catch(e) {
    res.json({ error: e.message });
  } finally {
    await page.close().catch(() => {});
  }
});

app.get('/test-stream', async (req, res) => {
  const slug = req.query.slug || 'zootropolis-2';
  const pageUrl = `${BASE}/filmes/${slug}/`;
  const log = [];
  const br = await getBrowser();
  const page = await br.newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url(), rt = req.resourceType();
      if (['image','font','media'].includes(rt)) return req.abort();
      if (['googlesyndication','doubleclick','amazon-adsystem'].some(h => u.includes(h))) return req.abort();
      req.continue();
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');

    // Login using page.evaluate to directly set field values
    await page.goto('https://osteusfilmestuga.online/a-minha-conta/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    const loginResult = await page.evaluate(async (user, pass) => {
      // Find all input fields
      const inputs = Array.from(document.querySelectorAll('input'));
      const userInput = inputs.find(i => i.type === 'text' || i.type === 'email' || i.name === 'username' || i.id === 'username');
      const passInput = inputs.find(i => i.type === 'password');
      if (!userInput || !passInput) return { error: 'fields not found', inputs: inputs.map(i => ({ type: i.type, name: i.name, id: i.id })) };
      // Set values using native setter to trigger React/Vue events
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(userInput, user);
      userInput.dispatchEvent(new Event('input', { bubbles: true }));
      nativeInputValueSetter.call(passInput, pass);
      passInput.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = document.querySelector('button[name="login"]') || document.querySelector('button[type="submit"]') || document.querySelector('input[type="submit"]');
      if (!btn) return { error: 'button not found' };
      btn.click();
      return { ok: true, userField: userInput.name || userInput.id, passField: passInput.name || passInput.id };
    }, process.env.WP_USER || '', process.env.WP_PASS || '');
    log.push({ step: 'login_eval', result: loginResult });
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    // If still on login page, try form.submit()
    if (page.url().includes('a-minha-conta')) {
      await page.evaluate((user, pass) => {
        const form = document.querySelector('form.woocommerce-form-login, form[method="post"]');
        if (!form) return;
        const inputs = Array.from(form.querySelectorAll('input'));
        const userInput = inputs.find(i => i.type !== 'hidden' && i.type !== 'submit' && i.type !== 'checkbox');
        const passInput = inputs.find(i => i.type === 'password');
        if (userInput) userInput.value = user;
        if (passInput) passInput.value = pass;
        form.submit();
      }, process.env.WP_USER || '', process.env.WP_PASS || '');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
    log.push({ step: 'after_login', url: page.url() });

    // Navigate to content page and get player options + nonce from logged-in page
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const pageInfo = await page.evaluate(() => {
      const nonce = (document.body.innerHTML.match(/"nonce"\s*:\s*"([a-f0-9]+)"/) || [])[1] || '';
      const tabs = Array.from(document.querySelectorAll('li.zetaflix_player_option')).map(li => ({
        postId: li.getAttribute('data-post'),
        type: li.getAttribute('data-type') || 'mv',
        nume: li.getAttribute('data-nume'),
      })).filter(t => t.postId && t.nume);
      const loggedIn = document.body.innerHTML.includes('Sair') || document.body.innerHTML.includes('logout');
      return { nonce, tabs, loggedIn };
    });
    log.push({ step: 'page_info', tabs: pageInfo.tabs.length, nonce: pageInfo.nonce?.slice(0,8), loggedIn: pageInfo.loggedIn });

    // Call API for first tab - try multiple auth approaches
    if (pageInfo.tabs.length > 0) {
      const tab = pageInfo.tabs[0];
      const apiUrl = '/wp-json/zetaplayer/v2/' + tab.postId + '/' + tab.type + '/' + tab.nume;
      const result = await page.evaluate(async (apiUrl, nonce) => {
        const results = {};
        // Try 1: with X-WP-Nonce from page
        try {
          const r1 = await fetch(apiUrl, { headers: { 'X-WP-Nonce': nonce }, credentials: 'include' });
          results.withNonce = { status: r1.status, body: (await r1.text()).slice(0, 200) };
        } catch(e) { results.withNonce = { error: e.message }; }
        // Try 2: no nonce header, just cookies
        try {
          const r2 = await fetch(apiUrl, { credentials: 'include' });
          results.withCookies = { status: r2.status, body: (await r2.text()).slice(0, 200) };
        } catch(e) { results.withCookies = { error: e.message }; }
        // Try 3: get fresh nonce from wp-json endpoint
        try {
          const nr = await fetch('/wp-json/', { credentials: 'include' });
          const ndata = await nr.json();
          // ndata doesn't have nonce but let's check
          results.wpJsonStatus = nr.status;
        } catch(e) {}
        // Try 4: get nonce via wp.apiFetch approach
        try {
          const nonceEl = document.querySelector('#wp-json-nonce, [data-nonce]');
          const freshNonce = nonceEl?.textContent || nonceEl?.getAttribute('data-nonce') || '';
          if (freshNonce && freshNonce !== nonce) {
            const r4 = await fetch(apiUrl, { headers: { 'X-WP-Nonce': freshNonce }, credentials: 'include' });
            results.withFreshNonce = { status: r4.status, nonce: freshNonce, body: (await r4.text()).slice(0, 200) };
          }
        } catch(e) { results.withFreshNonce = { error: e.message }; }
        return results;
      }, apiUrl, pageInfo.nonce);
      log.push({ step: 'api_call', apiUrl, result });
    }

    res.json({ pageUrl, log });
  } catch(e) {
    res.json({ pageUrl, error: e.message, log });
  } finally {
    await page.close().catch(() => {});
  }
});


// Stream proxy — forwards HLS requests with correct Referer header

// ─── Stream Proxies ───────────────────────────────────────────────────────────

// Debug: watch all m3u8 requests over time to find real stream after ads
app.get('/debug-child-m3u8', async (req, res) => {
  const embedUrl = req.query.embed || 'https://minochinos.com/embed/4u1yo63ktzoj';
  const blockAds = req.query.blockads !== '0'; // block by default
  const br = await getBrowser();
  const page = await br.newPage();
  const allRequests = [];
  let childContent = null;
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const u = req.url();
      if (['image','font'].includes(req.resourceType())) return req.abort();
      if (blockAds) {
        const adHosts = ['tiktokcdn','tiktok.com','googlesyndication','doubleclick','imasdk','googleads','yandex','mc.yandex'];
        if (adHosts.some(h => u.includes(h))) return req.abort();
        if (u.includes('minochinos.com/ad') || 
            u.includes('minochinos.com/assets/jquery/static.js') ||
            u.includes('pixibay.cc') ||
            u.includes('/dl?op=get_slides')) return req.abort();
      }
      if (u.includes('.m3u8') || u.includes('minochinos')) {
        allRequests.push({ t: Date.now(), type: 'request', url: u });
      }
      req.continue();
    });
    page.on('response', async resp => {
      const u = resp.url();
      if (u.includes('.m3u8') || u.includes('minochinos')) {
        const text = await resp.text().catch(() => '');
        allRequests.push({ t: Date.now(), type: 'response', url: u, snippet: text.slice(0, 200) });
        if (u.includes('index-v1-a1.m3u8') && !childContent) childContent = text.slice(0, 500);
      }
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await new Promise(r => setTimeout(r, 15000));
    res.json({ embedUrl, blockAds, allRequests, childContent });
  } catch(e) {
    res.json({ error: e.message, allRequests });
  } finally {
    await page.close().catch(() => {});
  }
});

app.get('/debug-m3u8', async (req, res) => {
  const embedUrl = req.query.embed || 'https://minochinos.com/embed/4u1yo63ktzoj';
  try {
    const br = await getBrowser();
    const page = await br.newPage();
    try {
      await page.setRequestInterception(true);
      let m3u8Url = null, referer = embedUrl;
      page.on('request', req => {
        const u = req.url();
        if (['image','font','media'].includes(req.resourceType())) return req.abort();
        const adHosts = ['tiktokcdn','tiktok.com','googlesyndication','doubleclick','imasdk','googleads','yandex','mc.yandex'];
        if (adHosts.some(h => u.includes(h))) return req.abort();
        if (u.includes('minochinos.com/ad') || u.includes('assets/jquery/static.js')) return req.abort();
        if (u.includes('master.m3u8') && u.includes('minochinos.com')) {
          m3u8Url = u;
          referer = req.headers()['referer'] || embedUrl;
        }
        req.continue();
      });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36');
      await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, 2000));

      // Force skip ads via JWPlayer API and extract real content URL
      const skipResult = await page.evaluate(() => {
        try {
          if (typeof jwplayer === 'undefined') return { error: 'no jwplayer' };
          const p = jwplayer();
          // Get advertising config
          const cfg = p.getConfig ? p.getConfig() : {};
          const adCfg = cfg.advertising || {};
          // Try to skip/disable ads and get playlist
          if (p.skipAd) p.skipAd();
          // Remove advertising schedule and play
          if (p.setConfig) p.setConfig({ advertising: null });
          if (p.play) p.play();
          return {
            adSchedule: JSON.stringify(adCfg).slice(0, 500),
            playlist: JSON.stringify(p.getPlaylist ? p.getPlaylist() : []).slice(0, 500),
          };
        } catch(e) { return { error: e.message }; }
      }).catch(e => ({ error: e.message }));
      console.log('[debug-m3u8] skipResult:', JSON.stringify(skipResult).slice(0, 300));

      // Extract JWPlayer config from raw HTML
      const pageHtml = await page.content().catch(() => '');
      const jwSetupMatch = pageHtml.match(/jwplayer[^)]*\.setup\s*\(\s*(\{[\s\S]{0,5000}?\})\s*\)/);
      const jwConfig = jwSetupMatch ? jwSetupMatch[1] : null;
      // Also look for any stream URLs in the HTML
      const streamUrls = [...pageHtml.matchAll(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/g)].map(m => m[0]);

      // Try JWPlayer API
      const jwApiData = await page.evaluate(() => {
        try {
          if (typeof jwplayer === 'undefined') return { error: 'jwplayer not defined' };
          const p = jwplayer();
          return {
            playlist: p.getPlaylist ? JSON.stringify(p.getPlaylist()) : null,
            config: p.getConfig ? JSON.stringify(p.getConfig()).slice(0, 3000) : null,
            state: p.getState ? p.getState() : null,
          };
        } catch(e) { return { error: e.message }; }
      }).catch(e => ({ error: e.message }));

      // Fetch master m3u8
      let content = '', status = 0;
      if (m3u8Url) {
        const resp = await page.evaluate(async (url, ref) => {
          const r = await fetch(url, { headers: { 'Referer': ref } });
          return { status: r.status, text: await r.text() };
        }, m3u8Url, referer);
        content = resp.text;
        status = resp.status;
      }

      // Click play — triggers VAST ad which will fail (blocked), then real content loads
      await page.evaluate(() => {
        const el = document.querySelector('.jw-icon-display, .jw-display-icon-container, [aria-label="Play"]');
        if (el) el.click();
        // Also try jwplayer API
        try { jwplayer().play(); } catch(e) {}
      }).catch(() => {});

      // Wait for 2nd master.m3u8 (real content after ad fails)
      const secondUrl = await new Promise(resolve => {
        let count = 0;
        const handler = req => {
          const u = req.url();
          if (u.includes('master.m3u8') && u.includes('minochinos.com')) {
            count++;
            if (count >= 2) {
              page.off('request', handler);
              resolve(u);
            }
          }
        };
        page.on('request', handler);
        setTimeout(() => resolve(null), 20000);
      });

      // Fetch child m3u8 of 2nd URL
      let childAfterWait = null;
      const targetUrl = secondUrl || m3u8Url;
      if (targetUrl) {
        const childUrl = targetUrl.replace('master.m3u8', 'index-v1-a1.m3u8');
        const childResp = await page.evaluate(async (url, ref) => {
          try {
            const r = await fetch(url, { headers: { 'Referer': ref } });
            return { status: r.status, first500: (await r.text()).slice(0, 500) };
          } catch(e) { return { error: e.message }; }
        }, childUrl, referer).catch(e => ({ error: e.message }));
        childAfterWait = { url: childUrl, secondMasterUrl: secondUrl, ...childResp };
      }

      // Also fetch the ad tag to find content stream
      const adTagData = await page.evaluate(async () => {
        try {
          const r = await fetch('/ad?type=87297795161');
          const text = await r.text();
          // Look for stream URLs in the ad tag response
          const urls = [...text.matchAll(/https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/g)].map(m => m[0]);
          return { length: text.length, urls, snippet: text.slice(0, 500) };
        } catch(e) { return { error: e.message }; }
      }).catch(e => ({ error: e.message }));

      res.json({
        m3u8Url,
        referer,
        status,
        content,
        firstSegment: content.split('\n').find(l => l.trim() && !l.startsWith('#')),
        streamUrlsInHtml: streamUrls,
        jwApiData,
        childAfterWait,
        adTagData,
      });
    } finally {
      await page.close().catch(() => {});
    }
  } catch(e) {
    res.json({ error: e.message });
  }
});

// Live stream: extracts fresh m3u8 from embed page and proxies it
app.get('/live-stream', async (req, res) => {
  const embedUrl = req.query.embed;
  if (!embedUrl) return res.status(400).send('Missing embed URL');
  try {
    const result = await extractDirectVideo(embedUrl);
    if (!result) return res.status(404).send('No stream found');

    const referer = result.referer || embedUrl;
    const origin = (() => { try { return new URL(referer).origin; } catch { return 'https://minochinos.com'; } })();

    // Use Puppeteer to fetch master m3u8 (Railway node-fetch can't reach minochinos.com)
    const br = await getBrowser();
    const page = await br.newPage();
    let text, status;
    try {
      const fetchResult = await page.evaluate(async (url, referer, origin) => {
        const resp = await fetch(url, { headers: { 'Referer': referer, 'Origin': origin } });
        return { status: resp.status, text: await resp.text() };
      }, result.url, referer, origin);
      status = fetchResult.status;
      text = fetchResult.text;
    } finally {
      await page.close().catch(() => {});
    }

    if (status !== 200) return res.status(status).send('m3u8 fetch failed: ' + status);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');

    const base = new URL(result.url);
    const rewritten = text.replace(/^(?!#)(.+)$/gm, line => {
      line = line.trim();
      if (!line) return line;
      const absUrl = line.startsWith('http') ? line : new URL(line, base).href;
      if (absUrl.includes('.m3u8')) {
        return ADDON_URL + '/proxy/m3u8?url=' + encodeURIComponent(absUrl)
          + '&ref=' + encodeURIComponent(referer)
          + '&ori=' + encodeURIComponent(origin);
      }
      return ADDON_URL + '/proxy/seg?url=' + encodeURIComponent(absUrl)
        + '&ref=' + encodeURIComponent(referer)
        + '&ori=' + encodeURIComponent(origin);
    });
    res.send(rewritten);
  } catch(e) {
    console.error('[live-stream]', e.message);
    res.status(500).send('Error: ' + e.message);
  }
});

// Segment proxy: uses persistent Puppeteer page to fetch segments (bypasses Railway DNS block on minochinos.com)
let proxyPage = null;
async function getProxyPage() {
  if (proxyPage && !proxyPage.isClosed()) return proxyPage;
  const br = await getBrowser();
  proxyPage = await br.newPage();
  await proxyPage.goto('about:blank');
  return proxyPage;
}

app.get('/proxy/seg', async (req, res) => {
  const url = req.query.url;
  const referer = req.query.ref || 'https://minochinos.com/';
  const origin = req.query.ori || (() => { try { return new URL(referer).origin; } catch { return 'https://minochinos.com'; } })();
  if (!url) return res.status(400).send('Missing url');
  try {
    const page = await getProxyPage();
    const result = await page.evaluate(async (url, referer, origin) => {
      const resp = await fetch(url, { headers: { 'Referer': referer, 'Origin': origin } });
      if (!resp.ok) return { error: resp.status };
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // Convert to base64
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      return { b64: btoa(binary), type: resp.headers.get('content-type') || 'video/mp2t' };
    }, url, referer, origin);
    if (result.error) return res.status(result.error).send('Segment fetch failed: ' + result.error);
    res.setHeader('Content-Type', result.type);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(result.b64, 'base64'));
  } catch(e) {
    res.status(500).send('Segment error: ' + e.message);
  }
});

// m3u8 proxy: uses Puppeteer to fetch child playlists (bypasses Railway DNS blocks)
app.get('/proxy/m3u8', async (req, res) => {
  const url = req.query.url;
  const referer = req.query.ref || 'https://minochinos.com/';
  const origin = req.query.ori || (() => { try { return new URL(referer).origin; } catch { return 'https://minochinos.com'; } })();
  if (!url) return res.status(400).send('Missing url');
  try {
    const page = await getProxyPage();
    const result = await page.evaluate(async (url, referer, origin) => {
      const resp = await fetch(url, { headers: { 'Referer': referer, 'Origin': origin } });
      return { status: resp.status, text: await resp.text() };
    }, url, referer, origin);
    if (result.status !== 200) return res.status(result.status).send('Child m3u8 failed');

    const base = new URL(url);
    const lines = result.text.split('\n');
    const filtered = [];
    let skipNext = false;
    for (const line of lines) {
      const trimmed = line.trim();
      // If this segment line is a TikTok ad URL, skip it and its preceding #EXTINF
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('tiktokcdn')) {
        // Remove the last #EXTINF line we added
        if (filtered.length && filtered[filtered.length - 1].startsWith('#EXTINF')) {
          filtered.pop();
        }
        continue;
      }
      if (!trimmed) { filtered.push(line); continue; }
      if (trimmed.startsWith('#')) { filtered.push(line); continue; }
      // Real segment — rewrite to proxy
      const absUrl = trimmed.startsWith('http') ? trimmed : new URL(trimmed, base).href;
      filtered.push(ADDON_URL + '/proxy/seg?url=' + encodeURIComponent(absUrl)
        + '&ref=' + encodeURIComponent(referer)
        + '&ori=' + encodeURIComponent(origin));
    }

    // If all segments were ads, return error
    const hasRealSegments = filtered.some(l => l.includes('/proxy/seg'));
    if (!hasRealSegments) {
      return res.status(503).send('Only ad segments found — real content not yet available');
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(filtered.join('\n'));
  } catch(e) {
    res.status(500).send('m3u8 proxy error: ' + e.message);
  }
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

