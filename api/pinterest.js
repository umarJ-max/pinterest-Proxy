// api/pinterest.js
// Deploy this to your existing Vercel project.
// Set PINTEREST_PROXY_URL in the app to point here.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ success: false, error: "No URL provided" });

  try {
    // Pinterest requires a real browser UA, otherwise it redirects to login
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });

    const html = await response.text();

    // Extract og:video
    const videoMatch =
      html.match(/<meta[^>]+property=["']og:video["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video["']/i) ||
      html.match(/["']video_url["']\s*:\s*["']([^"']+\.mp4[^"']*)/i);

    // Extract og:image
    const imageMatch =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);

    // Extract title
    const titleMatch =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<title>([^<]+)<\/title>/i);

    const videoUrl = videoMatch ? decodeHTMLEntities(videoMatch[1]) : null;
    const thumbnail = imageMatch ? decodeHTMLEntities(imageMatch[1]) : null;
    const title = titleMatch ? decodeHTMLEntities(titleMatch[1]) : "Pinterest Pin";

    if (!videoUrl && !thumbnail) {
      return res.status(200).json({
        success: false,
        error: "No downloadable media found. The pin may be image-only or private.",
      });
    }

    return res.status(200).json({
      success: true,
      mediaInfo: {
        title: title.replace(" | Pinterest", "").trim(),
        platform: "Pinterest",
        videoUrl: videoUrl || null,
        audioUrl: null,
        thumbnail: thumbnail || null,
        qualities: videoUrl ? [{ quality: "HD", url: videoUrl }] : [],
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

function decodeHTMLEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\\u002F/g, "/")
    .replace(/\\u0026/g, "&");
}
