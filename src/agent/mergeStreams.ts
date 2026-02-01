import { PassThrough, Readable } from "node:stream";

export function mergeStreams(streams: Readable[]): PassThrough {
  const merged = new PassThrough();
  if (streams.length === 0) {
    merged.end();
    return merged;
  }

  let remaining = streams.length;
  for (const stream of streams) {
    stream.on("data", (chunk) => merged.write(chunk));
    stream.on("end", () => {
      remaining -= 1;
      if (remaining === 0) merged.end();
    });
    stream.on("error", (error) => merged.emit("error", error));
  }

  return merged;
}
