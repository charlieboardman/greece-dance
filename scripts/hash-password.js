import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { hashPassword } from "../server/password.js";

let password;
if (process.stdin.isTTY) {
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  password = await new Promise((resolve) => { readline.question("Editor password: ", resolve); muted = true; });
  readline.close(); process.stdout.write("\n");
} else {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/u, "");
}
console.log(await hashPassword(password));
