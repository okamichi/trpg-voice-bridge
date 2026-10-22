import { timingSafeEqual } from "node:crypto";
import { HttpError, check } from "./contracts.mjs";

// Route handlers return true once they have answered.
export const equal = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a ?? ""),
    y = Buffer.from(b ?? "");
  return x.length === y.length && timingSafeEqual(x, y);
};
export const json = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
  return true;
};
export async function body(req, limit = 16384) {
  check(
    (req.headers["content-type"] ?? "").startsWith("application/json"),
    "JSONが必要です",
    415,
  );
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    check(size <= limit, "要求が大きすぎます", 413);
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks));
  } catch {
    throw new HttpError(400, "JSON形式が不正です");
  }
}
