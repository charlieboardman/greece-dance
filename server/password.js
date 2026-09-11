import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
export async function hashPassword(password) {
  if (password.length === 0) throw new Error("Enter a nonempty password.");
  const salt = randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${hash.toString("hex")}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || password.length > 1024 || !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/u.test(encoded || "")) return false;
  const [, salt, hash] = encoded.split(":");
  return timingSafeEqual(await scrypt(password, salt, 64), Buffer.from(hash, "hex"));
}

