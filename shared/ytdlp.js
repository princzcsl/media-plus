// yt-dlp format choice for a video download: format (-f) and sort order (-S).
// A codec filter falls back to the best video when the site doesn't offer that codec.

export const CODECS = ['auto', 'h264', 'vp9', 'av1'];
export const HEIGHTS = [0, 2160, 1440, 1080, 720, 480, 360];

const FILTER = {
  h264: '[vcodec^=avc1]',
  vp9: "[vcodec~='^vp0?9']",
  av1: '[vcodec^=av01]'
};

export function videoSpec({ codec = 'auto', height = 0 } = {}) {
  const sortSpec = `${height ? `res:${height}` : 'res'},ext:mp4:m4a`;
  const f = FILTER[codec];
  if (!f) return { formatSpec: 'bv*+ba/b', sortSpec };
  // H.264 goes with AAC so the file opens in editors (Premiere Pro, Resolve, Final Cut…).
  const audio = codec === 'h264' ? `bv*${f}+ba[acodec^=mp4a]/` : '';
  return { formatSpec: `${audio}bv*${f}+ba/b${f}/bv*+ba/b`, sortSpec };
}
