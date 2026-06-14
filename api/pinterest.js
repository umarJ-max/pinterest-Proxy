// api/pinterest.js  — CommonJS, Vercel Node.js serverless
// Ported from app.py: tries Pinterest's internal PinResource API first,
// falls back to HTML scraping with same patterns as the working local version.

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, error: "No URL provided" });
  if (!url.includes("pinterest.com") && !url.includes("pin.it"))
    return res.status(400).json({ success: false, error: "Not a Pinterest URL" });

  try {
    const result = await scrapePin(url);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(200).json({ success: false, error: "Proxy error: " + err.message });
  }
};

// ─── Headers (mirrored from app.py) ──────────────────────────────────────────

const PAGE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.pinterest.com/",
  "Upgrade-Insecure-Requests": "1",
};

const API_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.pinterest.com/",
  "X-Requested-With": "XMLHttpRequest",
  "X-Pinterest-AppState": "active",
  "X-APP-VERSION": "b76e5b3",
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function scrapePin(rawUrl) {
  // Resolve pin.it shortlinks
  let url = rawUrl.trim();
  if (!url.startsWith("http")) url = "https://" + url;
  if (url.includes("pin.it")) {
    const r = await fetchUrl(url, PAGE_HEADERS, true);
    url = r.finalUrl;
  }
  // Clean URL
  url = url.replace(/\?.*$/, "").replace(/\/(sent|embed|explore)\/?$/, "/");
  if (!url.endsWith("/")) url += "/";

  const pinIdMatch = url.match(/\/pin\/(\d+)/);
  const pinId = pinIdMatch ? pinIdMatch[1] : null;

  const result = { type: "image", mediaUrl: null, thumbnail: null, title: "Pinterest Pin" };

  // ── Method 1: Pinterest internal PinResource API ──────────────────────────
  // First hit homepage to get csrftoken cookie (same as app.py session.get homepage)
  let csrfToken = "";
  let cookieHeader = "";
  try {
    const homeRes = await fetchUrl("https://www.pinterest.com/", PAGE_HEADERS, false);
    const setCookies = homeRes.headers["set-cookie"] || [];
    const cookieArr = Array.isArray(setCookies) ? setCookies : [setCookies];
    const parsed = {};
    for (const c of cookieArr) {
      const m = c.match(/^([^=]+)=([^;]*)/);
      if (m) parsed[m[1].trim()] = m[2].trim();
    }
    csrfToken = parsed["csrftoken"] || "";
    cookieHeader = Object.entries(parsed).map(([k, v]) => `${k}=${v}`).join("; ");
  } catch (_) {}

  if (pinId) {
    try {
      const dataParam = encodeURIComponent(
        JSON.stringify({ options: { id: pinId, field_set_key: "detailed" }, context: {} })
      );
      const apiUrl = `https://www.pinterest.com/resource/PinResource/get/?source_url=/pin/${pinId}/&data=${dataParam}&_=1`;
      const apiHdrs = { ...API_HEADERS };
      if (csrfToken) apiHdrs["X-CSRFToken"] = csrfToken;
      if (cookieHeader) apiHdrs["Cookie"] = cookieHeader;

      const apiRes = await fetchUrl(apiUrl, apiHdrs, false);
      if (apiRes.status === 200) {
        let apiData;
        try { apiData = JSON.parse(apiRes.body); } catch (_) {}
        if (apiData) {
          const pin = apiData?.resource_response?.data;
          if (pin && typeof pin === "object") {
            const t = (pin.title || pin.description || "").trim();
            if (t) result.title = t.slice(0, 80);

            // Thumbnail
            const images = pin.images || {};
            for (const size of ["orig", "736x", "474x"]) {
              const img = images[size];
              if (img && img.url) { result.thumbnail = img.url; break; }
            }

            // Video
            const vBlock = pin.videos || {};
            let vl = (typeof vBlock === "object" && vBlock.video_list) || pin.video_list || {};
            if (vl && typeof vl === "object" && Object.keys(vl).length) {
              const vidUrl = pickVideoUrl(vl);
              if (vidUrl) { result.type = "video"; result.mediaUrl = vidUrl; }
            }

            // Image fallback from API
            if (result.type === "image") {
              for (const size of ["orig", "736x", "474x"]) {
                const img = images[size];
                if (img && img.url) {
                  result.mediaUrl = img.url.replace(/\/\d+x\//, "/originals/");
                  break;
                }
              }
            }
          }
        }
      }
    } catch (_) {}
  }

  // ── Method 2: HTML scraping fallback (same as app.py Method 2) ───────────
  if (!result.mediaUrl) {
    const hdrs = { ...PAGE_HEADERS };
    if (cookieHeader) hdrs["Cookie"] = cookieHeader;
    const pageRes = await fetchUrl(url, hdrs, false);
    if (pageRes.status === 200) {
      const html = pageRes.body;

      // Title
      if (result.title === "Pinterest Pin") {
        const ogT = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)
                 || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i);
        if (ogT && ogT[1] !== "Pinterest") result.title = ogT[1].trim().slice(0, 80);
        if (result.title === "Pinterest Pin") {
          const st = html.match(/"seoTitle"\s*:\s*"([^"]{5,}?)"/);
          if (st && !st[1].includes("Pinterest")) result.title = st[1].slice(0, 80);
        }
      }

      // Thumbnail from og:image
      if (!result.thumbnail) {
        const ogI = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
                 || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
        if (ogI) result.thumbnail = ogI[1];
      }

      // Video extraction
      if (html.includes("video_list") || html.includes("videoList")) {
        const vidUrl = extractVideoFromHtml(html);
        if (vidUrl) { result.type = "video"; result.mediaUrl = vidUrl; }
      }

      // Image extraction
      if (result.type === "image") {
        result.mediaUrl = extractImageFromHtml(html);
      }

      // Story/idea pin
      if (result.type === "image" && html.includes("story_pin_data")) {
        for (const m of matchAll(html, /"video_list"\s*:\s*\{/g)) {
          const blob = braceExtract(html, m.index + m[0].length - 1);
          if (!blob) continue;
          try {
            const vl = JSON.parse(blob);
            const vidUrl = pickVideoUrl(vl);
            if (vidUrl) { result.type = "video"; result.mediaUrl = vidUrl; break; }
          } catch (_) {}
        }
      }

      // Regex MP4 fallback
      if (result.type === "image" && html.includes("v.pinimg.com")) {
        for (const pat of [
          /https:\/\/v\.pinimg\.com\/videos\/mc\/720p\/[^\s"'\\]+\.mp4/g,
          /https:\/\/v\.pinimg\.com\/videos\/mc\/480p\/[^\s"'\\]+\.mp4/g,
          /https:\/\/v\.pinimg\.com\/[^\s"'\\]+\.mp4/g,
        ]) {
          const found = html.match(pat);
          if (found) { result.type = "video"; result.mediaUrl = found[0].replace(/\\\//g, "/"); break; }
        }
      }
    }
  }

  if (!result.mediaUrl) {
    return { success: false, error: "Could not find media. The pin may be private or unsupported." };
  }

  const isVideo = result.type === "video";
  return {
    success: true,
    mediaInfo: {
      title: result.title,
      platform: "Pinterest",
      videoUrl: result.mediaUrl,
      audioUrl: null,
      thumbnail: result.thumbnail || null,
      qualities: [{ quality: isVideo ? "HD" : "Image", url: result.mediaUrl }],
      isImage: !isVideo,
    },
  };
}

// ─── Video extraction (ported from app.py extract_video_from_html) ────────────

function pickVideoUrl(vl) {
  for (const q of ["V_720P", "V_480P", "V_EXP6", "V_HLSV4_MBAT_V720P", "V_HLS"]) {
    const e = vl[q];
    if (e && typeof e === "object" && e.url) return e.url;
  }
  for (const e of Object.values(vl)) {
    if (e && typeof e === "object" && e.url) return e.url;
  }
  return null;
}

function extractVideoFromHtml(html) {
  // Pattern A: classic video_list
  for (const m of matchAll(html, /"video_list"\s*:\s*\{/g)) {
    const blob = braceExtract(html, m.index + m[0].length - 1);
    if (!blob) continue;
    try {
      const vl = JSON.parse(blob);
      const u = pickVideoUrl(vl);
      if (u) return u;
    } catch (_) {}
  }

  // Pattern B: newer videoList
  for (const m of matchAll(html, /"videoList"\s*:\s*\{/g)) {
    const blob = braceExtract(html, m.index + m[0].length - 1);
    if (!blob) continue;
    try {
      const vl = JSON.parse(blob);
      for (const key of ["v720P", "v480P", "v360P", "v1080P"]) {
        const e = vl[key];
        if (e && e.url && e.url.includes(".mp4")) return e.url;
      }
      const exp = vl.expMp4 || vl.V_EXP6;
      if (exp && exp.url && exp.url.includes(".mp4")) return exp.url;
      const mp4s = blob.match(/https:\/\/v\d*\.pinimg\.com\/[^"\s]+\.mp4/g);
      if (mp4s) {
        for (const res of ["720", "1080", "540", "480"]) {
          const best = mp4s.filter(u => u.includes(res));
          if (best.length) return best[0];
        }
        return mp4s[0];
      }
      const hls = vl.vHLSV4 || vl.vHLS;
      if (hls && hls.url && hls.url.includes(".m3u8")) return hls.url;
    } catch (_) {
      const mp4s = blob ? blob.match(/https:\/\/v\d*\.pinimg\.com\/[^"\s]+\.mp4/g) : null;
      if (mp4s) return mp4s[0];
    }
  }

  // Pattern C: direct regex
  for (const pat of [
    /https:\/\/v\d*\.pinimg\.com\/[^"\s]*_720w\.mp4/g,
    /https:\/\/v\d*\.pinimg\.com\/[^"\s]*_540w\.mp4/g,
    /https:\/\/v\d*\.pinimg\.com\/videos\/[^"\s]+\.mp4/g,
    /https:\/\/v\d*\.pinimg\.com\/[^"\s]+\.mp4/g,
  ]) {
    const found = html.match(pat);
    if (found) return found[0].replace(/\\\//g, "/");
  }
  return null;
}

// ─── Image extraction (ported from app.py extract_image_from_html) ────────────

const SKIP_HASHES = ["d53b014d86a6b6761bf649a0ed813c2b"];

function isValidImageUrl(url) {
  if (SKIP_HASHES.some(h => url.includes(h))) return false;
  if (["/75x75/", "/30x30/", "/14x14/"].some(s => url.includes(s))) return false;
  return true;
}

function extractImageFromHtml(html) {
  // Priority 1: "orig":{"url":"..."}
  for (const m of matchAll(html, /"orig"\s*:\s*\{"url"\s*:\s*"(https:\/\/i\.pinimg\.com\/[^"]+)"/g)) {
    if (isValidImageUrl(m[1])) return m[1];
  }
  // Priority 2: 736x upgraded to originals
  for (const m of matchAll(html, /"736x"\s*:\s*\{"url"\s*:\s*"(https:\/\/i\.pinimg\.com\/[^"]+)"/g)) {
    const u = m[1].replace(/\/\d+x\//, "/originals/");
    if (isValidImageUrl(u)) return u;
  }
  // Priority 3: og:image
  const ogI = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
            || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
  if (ogI && isValidImageUrl(ogI[1]) && ogI[1].includes("pinimg.com"))
    return ogI[1].replace(/\/\d+x\//, "/originals/");
  // Priority 4: originals path regex
  const origs = html.match(/https:\/\/i\.pinimg\.com\/originals\/[^\s"'\\]+\.(?:jpg|jpeg|png|gif|webp)/gi);
  if (origs) {
    for (const u of origs) { if (isValidImageUrl(u)) return u.replace(/\\\//g, "/"); }
  }
  // Priority 5: 736x upgraded
  const t736 = html.match(/https:\/\/i\.pinimg\.com\/736x\/[^\s"'\\]+\.(?:jpg|jpeg|png|gif|webp)/gi);
  if (t736) {
    for (const u of t736) {
      const up = u.replace(/\/\d+x\//, "/originals/").replace(/\\\//g, "/");
      if (isValidImageUrl(up)) return up;
    }
  }
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function braceExtract(html, start, maxLen = 600000) {
  let depth = 0, inStr = false, esc = false;
  const end = Math.min(start + maxLen, html.length);
  for (let i = start; i < end; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === "\\" && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  return null;
}

function* matchAll(str, regex) {
  let m;
  const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g");
  while ((m = re.exec(str)) !== null) yield m;
}

async function fetchUrl(url, headers, followRedirect) {
  const res = await fetch(url, {
    method: "GET",
    headers,
    redirect: followRedirect ? "follow" : "manual",
  });
  const body = await res.text();
  // Extract set-cookie from headers
  const setCookie = [];
  res.headers.forEach((val, key) => { if (key.toLowerCase() === "set-cookie") setCookie.push(val); });
  return {
    status: res.status,
    body,
    finalUrl: res.url,
    headers: { "set-cookie": setCookie },
  };
}
