require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const crypto = require('crypto');

const BASE_URL = process.env.CINEVEZ_BASE_URL || 'https://www.cinevez.foo';
const PROXY_URL = process.env.CINEVEZ_PROXY_URL || '';
const ENABLE_STREAMTAPE = process.env.ENABLE_STREAMTAPE !== 'false';
const ENABLE_DIRECT = process.env.ENABLE_DIRECT !== 'false';
const MIN_QUALITY = process.env.MIN_QUALITY || '720p';
const CACHE_DIR = process.env.VERCEL ? path.join('/tmp', '.cache') : path.join(__dirname, '..', '.cache');
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Cache helpers (from xprime.js)
const ensureCacheDir = async (dirPath) => {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      console.warn(`[Cinevez] Warning: Could not create cache directory ${dirPath}: ${error.message}`);
    }
  }
};

const getFromCache = async (cacheKey, subDir = '') => {
  if (process.env.DISABLE_CACHE === 'true') {
    console.log(`[Cinevez] CACHE DISABLED: Skipping read for ${path.join(subDir, cacheKey)}`);
    return null;
  }
  const cachePath = path.join(CACHE_DIR, subDir, cacheKey);
  try {
    const data = await fs.readFile(cachePath, 'utf-8');
    console.log(`[Cinevez] CACHE HIT for: ${path.join(subDir, cacheKey)}`);
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[Cinevez] CACHE READ ERROR for ${cacheKey}: ${error.message}`);
    }
    return null;
  }
};

const saveToCache = async (cacheKey, content, subDir = '') => {
  if (process.env.DISABLE_CACHE === 'true') {
    console.log(`[Cinevez] CACHE DISABLED: Skipping write for ${path.join(subDir, cacheKey)}`);
    return;
  }
  const fullSubDir = path.join(CACHE_DIR, subDir);
  await ensureCacheDir(fullSubDir);
  const cachePath = path.join(fullSubDir, cacheKey);
  try {
    const dataToSave = typeof content === 'string' ? content : JSON.stringify(content);
    await fs.writeFile(cachePath, dataToSave, 'utf-8');
    console.log(`[Cinevez] SAVED TO CACHE: ${path.join(subDir, cacheKey)}`);
  } catch (error) {
    console.warn(`[Cinevez] CACHE WRITE ERROR for ${cacheKey}: ${error.message}`);
  }
};

// Fetch stream size (from xprime.js)
const fetchStreamSize = async (url) => {
  const cacheSubDir = 'cinevez_stream_sizes';
  const urlHash = crypto.createHash('md5').update(url).digest('hex');
  const urlCacheKey = `${urlHash}.txt`;
  const cachedSize = await getFromCache(urlCacheKey, cacheSubDir);
  if (cachedSize !== null) return cachedSize;

  try {
    if (url.toLowerCase().includes('.m3u8')) {
      await saveToCache(urlCacheKey, 'Playlist (size N/A)', cacheSubDir);
      return 'Playlist (size N/A)';
    }
    const { default: fetch } = await import('node-fetch');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timeoutId);
      if (response.headers.has('content-length')) {
        const sizeInBytes = parseInt(response.headers.get('content-length'), 10);
        if (!isNaN(sizeInBytes)) {
          let formattedSize;
          if (sizeInBytes < 1024) formattedSize = `${sizeInBytes} B`;
          else if (sizeInBytes < 1024 * 1024) formattedSize = `${(sizeInBytes / 1024).toFixed(2)} KB`;
          else if (sizeInBytes < 1024 * 1024 * 1024) formattedSize = `${(sizeInBytes / (1024 * 1024)).toFixed(2)} MB`;
          else formattedSize = `${(sizeInBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
          await saveToCache(urlCacheKey, formattedSize, cacheSubDir);
          return formattedSize;
        }
      }
      await saveToCache(urlCacheKey, 'Unknown size', cacheSubDir);
      return 'Unknown size';
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    console.warn(`[Cinevez] Could not fetch size for ${url.substring(0, 50)}... : ${error.message}`);
    await saveToCache(urlCacheKey, 'Unknown size', cacheSubDir);
    return 'Unknown size';
  }
};

// Fetch with retry (from xprime.js)
async function fetchWithRetry(url, options, maxRetries = MAX_RETRIES) {
  const { default: fetch } = await import('node-fetch');
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`HTTP error! Status: ${response.status} ${response.statusText}. Body: ${errorBody.substring(0, 200)}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      console.warn(`[Cinevez] Fetch attempt ${attempt}/${maxRetries} failed for ${url}: ${error.message}`);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * Math.pow(2, attempt - 1)));
      }
    }
  }
  throw lastError || new Error(`[Cinevez] All fetch attempts failed for ${url}`);
}

// Scrape Cinevez streams
async function getCinevezStreams(title, year, type, seasonNum, episodeNum, useProxy = true) {
  if (!title || !year) {
    console.log('[Cinevez] Skipping fetch: title or year is missing.');
    return [];
  }
  if (type !== 'movie') {
    console.log(`[Cinevez] Skipping request: only movies supported, got type '${type}'.`);
    return [];
  }

  const cacheKey = `streams:${crypto.createHash('md5').update(`${title}:${year}`).digest('hex')}`;
  const cached = await getFromCache(cacheKey);
  if (cached) return cached;

  try {
    console.log(`[Cinevez] Fetching streams for '${title}' (${year})`);
    // Search Cinevez for the movie
    const searchUrl = PROXY_URL && useProxy ? `${PROXY_URL}?destination=${BASE_URL}/?s=${encodeURIComponent(title)}` : `${BASE_URL}/?s=${encodeURIComponent(title)}`;
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(searchUrl, { waitUntil: 'networkidle2' });
    const searchHtml = await page.content();
    let movieUrl = null;

    // Find movie page URL
    const $search = cheerio.load(searchHtml);
    $search('.movie-item').each((i, element) => {
      const itemTitle = $search(element).find('.movie-title').text().trim();
      const itemYear = $search(element).find('.movie-year').text().trim();
      if (itemTitle.toLowerCase().includes(title.toLowerCase()) && itemYear === year.toString()) {
        movieUrl = $search(element).find('a').attr('href');
        movieUrl = movieUrl?.startsWith('http') ? movieUrl : `${BASE_URL}${movieUrl}`;
        return false; // Break loop
      }
    });
    await browser.close();

    if (!movieUrl) {
      console.log(`[Cinevez] Movie not found: ${title} (${year})`);
      return [];
    }

    // Scrape movie page
    const fetchUrl = PROXY_URL && useProxy ? `${PROXY_URL}?destination=${movieUrl}` : movieUrl;
    const browser2 = await puppeteer.launch({ headless: true });
    const page2 = await browser2.newPage();
    await page2.goto(fetchUrl, { waitUntil: 'networkidle2' });
    const html = await page2.content();
    await browser2.close();

    const $ = cheerio.load(html);
    const streams = [];

    // Direct download links
    if (ENABLE_DIRECT) {
      $('a:contains("Direct Download")').each((i, element) => {
        const href = $(element).attr('href');
        const text = $(element).text().trim();
        if (href && text.includes(MIN_QUALITY)) {
          streams.push({
            url: href,
            title: `Cinevez ${text}`,
            quality: text.match(/1080p|720p|700MB/)?.[0] || 'Unknown',
            provider: 'Cinevez',
            size: 'Unknown size',
          });
        }
      });
    }

    // StreamTape
    if (ENABLE_STREAMTAPE) {
      const streamTapeLink = $('a:contains("StreamTape")').attr('href');
      if (streamTapeLink) {
        const streamUrl = await getStreamTapeUrl(streamTapeLink, useProxy);
        if (streamUrl) {
          streams.push({
            url: streamUrl,
            title: 'Cinevez StreamTape',
            quality: 'Unknown',
            provider: 'Cinevez StreamTape',
            size: 'Unknown size',
          });
        }
      }
    }

    // Fetch stream sizes
    if (streams.length > 0) {
      console.time('[Cinevez] Fetch stream sizes');
      const sizePromises = streams.map(async (stream) => {
        stream.size = await fetchStreamSize(stream.url);
        return stream;
      });
      const streamsWithSizes = await Promise.all(sizePromises);
      console.timeEnd('[Cinevez] Fetch stream sizes');
      await saveToCache(cacheKey, streamsWithSizes);
      return streamsWithSizes;
    }

    await saveToCache(cacheKey, streams);
    return streams;
  } catch (error) {
    console.error(`[Cinevez] Error fetching streams for ${title} (${year}): ${error.message}`);
    return [];
  }
}

// Resolve StreamTape URLs
async function getStreamTapeUrl(streamTapeLink, useProxy) {
  try {
    const url = useProxy && PROXY_URL ? `${PROXY_URL}?destination=${streamTapeLink}` : streamTapeLink;
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });
    const videoUrl = await page.evaluate(() => document.querySelector('video')?.src);
    await browser.close();
    return videoUrl || '';
  } catch (error) {
    console.error(`[Cinevez] Error resolving StreamTape: ${error.message}`);
    return '';
  }
}

// Initialize cache directory
ensureCacheDir(CACHE_DIR).catch(console.error);

module.exports = { getCinevezStreams };
