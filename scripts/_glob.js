/* 简易递归文件查找（避免引入第三方依赖） */
'use strict';
const fs = require('fs');
const path = require('path');

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

module.exports = function glob(dir, pattern) {
  const all = walk(dir, []);
  return all.filter((p) => pattern.test(p));
};
