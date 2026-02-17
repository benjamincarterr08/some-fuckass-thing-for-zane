import Fastify from "fastify";
import { request } from "undici";
import "dotenv/config";
import sql from "mssql";

const app = Fastify({ logger: false });

const dbConfig = {
  server: process.env.db,
  database: process.env.dbname,
  user: process.env.dbuser,
  password: process.env.dbpwd,
  options: {
    encrypt: (process.env.dbopt || "").toLowerCase().includes("encrypt=yes"),
    trustServerCertificate: true,
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

let pool;
async function getDb() {
  if (pool) return pool;
  pool = await sql.connect(dbConfig);
  return pool;
}


async function getJson(url) {
  const { statusCode, body } = await request(url, { method: "GET" });
  const text = await body.text();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`GET ${url} failed: ${statusCode} ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

function extractArtistTitle(nowPlaying) {
  const artist = nowPlaying?.song?.artist || "";
  const title = nowPlaying?.song?.title || "";
  const text = nowPlaying?.song?.text || "";

  if (artist && title) return { artist, title, raw: text || `${artist} - ${title}` };

  const parts = (text || "").split(" - ");
  if (parts.length >= 2) {
    return {
      artist: parts[0].trim(),
      title: parts.slice(1).join(" - ").trim(),
      raw: text,
    };
  }

  return { artist: artist || "Unknown", title: title || "Unknown", raw: text || "Unknown" };
}

function sanitiseArtistTitle(artist, title) {
  let a = (artist || "").trim();
  let t = (title || "").trim();

  let feat = "";

  const parenFeat = a.match(/\((feat\.|ft\.)\s*([^)]+)\)/i);
  if (parenFeat) {
    feat = parenFeat[2].trim();
    a = a.replace(parenFeat[0], "").trim();
  }

  const inlineFeat = a.match(/\b(feat\.|ft\.)\s+(.+)$/i);
  if (!feat && inlineFeat) {
    feat = inlineFeat[2].trim();
    a = a.replace(inlineFeat[0], "").trim();
  }

  if (feat) {
    if (!/\b(feat\.|ft\.)\b/i.test(t)) {
      t = `${t} (feat. ${feat})`;
    }
  }

  const junkRegex =
    /\s*[\(\[]\s*(radio edit|edit|remaster(ed)?(\s*\d{4})?|clean|explicit|mono|stereo|extended|extended mix|mix|version)\s*[\)\]]\s*/gi;
  t = t.replace(junkRegex, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/\s*[-—]\s*$/, "").trim();
  a = a.replace(/\s+/g, " ").trim();

  return { artist: a, title: t };
}

const metaOverrideCache = new Map(); 

async function getMetaOverride(rawMetadata) {
  const key = (rawMetadata || "").trim();
  if (!key) return null;

  const cached = metaOverrideCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.row;

  const db = await getDb();
  const r = await db
    .request()
    .input("RawMetadata", sql.NVarChar(sql.MAX), key)
    .query(
      "SELECT TOP 1 RawMetadata, NewName, NewArtist, NewArtURL FROM MetaOverride WHERE RawMetadata = @RawMetadata ORDER BY Id DESC"
    );

  const row = r.recordset?.[0] || null;
  metaOverrideCache.set(key, { row, expiresAt: Date.now() + 60_000 });
  return row;
}

async function sendNowPlayingEmbed({ artist, title, coverArt }) {
  const webhook = process.env.webhook;
  if (!webhook) return;

  const embed = {
    title: "Now Playing",
    description: `Artist: ${artist}\nSong Name: ${title}`,
    image: coverArt ? { url: coverArt } : undefined,
    timestamp: new Date().toISOString(),
  };

  await request(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });
}

let lastSavedRaw = null;
let lastSavedPayload = null;

async function getLastSongFromDb() {
  const db = await getDb();
  const r = await db
    .request()
    .query("SELECT TOP 1 SongName, ArtistName, AlbumArtUrl, RawMetadata, CreatedAt FROM SongHistory ORDER BY Id DESC");
  return r.recordset?.[0] || null;
}

app.get("/np", async () => {
  const az = await getJson("http://dj.upbeat.pw/api/nowplaying/1");
  const np = az?.now_playing;

  const { artist: azArtist, title: azTitle, raw } = extractArtistTitle(np);
  const rawMetadata = (raw || `${azArtist} - ${azTitle}`).trim();

  if ((azArtist || "").trim().toLowerCase() === "upbeat") {
    if (lastSavedPayload) return lastSavedPayload;

    const lastDb = await getLastSongFromDb();
    return lastDb
      ? {
          artist: lastDb.ArtistName,
          title: lastDb.SongName,
          coverArt: lastDb.AlbumArtUrl,
          rawMetadata: lastDb.RawMetadata,
          source: "db_fallback",
        }
      : {
          artist: "UpBeat",
          title: "No history yet",
          coverArt: null,
          rawMetadata,
          source: "none",
        };
  }

  const base = sanitiseArtistTitle(azArtist, azTitle);
  let finalArtist = base.artist;
  let finalTitle = base.title;
  let finalCoverArt = np?.song?.art || null;

  const override = await getMetaOverride(rawMetadata);
  if (override) {
    if (override.NewArtist && override.NewArtist.trim()) finalArtist = override.NewArtist.trim();
    if (override.NewName && override.NewName.trim()) finalTitle = override.NewName.trim();
    if (override.NewArtURL && override.NewArtURL.trim()) finalCoverArt = override.NewArtURL.trim();

    const san2 = sanitiseArtistTitle(finalArtist, finalTitle);
    finalArtist = san2.artist;
    finalTitle = san2.title;
  }

  let spotify = null;
  if (!override?.NewArtURL) {
    const lookupUrl =
      `https://tools.liftuphosting.com/api/v2/lookup/song?` +
      `title=${encodeURIComponent(finalTitle)}&artist=${encodeURIComponent(finalArtist)}`;

    try {
      const s = await getJson(lookupUrl);
      if (s && s.error === false && s.found && s.result) spotify = s.result;
    } catch {
    }

    if (spotify?.covers?.big) finalCoverArt = spotify.covers.big;
  }

  const rawKey = rawMetadata;
  if (rawKey && lastSavedRaw === rawKey) {
    return (
      lastSavedPayload || {
        artist: finalArtist,
        title: finalTitle,
        coverArt: finalCoverArt,
        rawMetadata,
        overrideApplied: Boolean(override),
        spotifyFound: Boolean(spotify),
        spotifyId: spotify?.spotify_id || null,
        skippedSave: true,
      }
    );
  }

  const db = await getDb();
  await db
    .request()
    .input("SongName", sql.NVarChar(255), finalTitle)
    .input("ArtistName", sql.NVarChar(255), finalArtist)
    .input("AlbumArtUrl", sql.NVarChar(1024), finalCoverArt)
    .input("RawMetadata", sql.NVarChar(sql.MAX), rawMetadata)
    .query(
      "INSERT INTO SongHistory (SongName, ArtistName, AlbumArtUrl, RawMetadata) VALUES (@SongName, @ArtistName, @AlbumArtUrl, @RawMetadata)"
    );

  const payload = {
    artist: finalArtist,
    title: finalTitle,
    coverArt: finalCoverArt,
    rawMetadata,
    overrideApplied: Boolean(override),
    spotifyFound: Boolean(spotify),
    spotifyId: spotify?.spotify_id || null,
    saved: true,
    savedAt: Date.now(),
  };

  lastSavedRaw = rawKey;
  lastSavedPayload = payload;

  sendNowPlayingEmbed(payload).catch(() => {});
  return payload;
});
const port = process.env.port || 11111;

app.listen({ port, host: "0.0.0.0" }, () => {
  console.log("API online");
});
