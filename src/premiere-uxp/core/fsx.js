"use strict";
// Promise helpers over the UXP `fs` module (require('fs')), whose functions return a Promise when no
// callback is passed. Node's fs.promises has the same shape, which the unit tests use.

function createFsx(fs) {
  async function stat(p) {
    try {
      return await fs.lstat(p);
    } catch (e) {
      return null;
    }
  }
  function flag(st, name) {
    if (!st) return false;
    const v = st[name];
    return typeof v === "function" ? !!v.call(st) : !!v;
  }
  return {
    raw: fs,
    async exists(p) {
      return (await stat(p)) !== null;
    },
    async isDir(p) {
      return flag(await stat(p), "isDirectory");
    },
    async isFile(p) {
      return flag(await stat(p), "isFile");
    },
    async readText(p) {
      return String(await fs.readFile(p, { encoding: "utf-8" }));
    },
    async writeText(p, text) {
      await fs.writeFile(p, text, { encoding: "utf-8" });
    },
    async appendText(p, text) {
      await fs.writeFile(p, text, { encoding: "utf-8", flag: "a" });
    },
    async mkdirp(p) {
      try {
        await fs.mkdir(p, { recursive: true });
      } catch (e) {
        if (!flag(await stat(p), "isDirectory")) throw e;
      }
    },
    async copy(src, dest) {
      await fs.copyFile(src, dest);
    },
    async remove(p) {
      await fs.unlink(p);
    },
    async rename(a, b) {
      await fs.rename(a, b);
    },
    async list(dir) {
      const names = await fs.readdir(dir);
      return Array.from(names, (n) => (typeof n === "string" ? n : n.name));
    },
  };
}

module.exports = { createFsx };
