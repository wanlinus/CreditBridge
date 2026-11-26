// 测试共用的最小断言工具。每个测试文件原来都复制一遍 `pass/fail/check/section`，
// 19 份样板近 300 行重复——抽到这里，测试文件只写「断言什么」。
//
// 用法：
//   import { check, section, done } from './_helpers.mjs';
//   section('1. 标题');
//   check('断言名', actual, expected);
//   done();

let pass = 0;
let fail = 0;

export function check(name, actual, expected = true) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

export function section(title) {
  console.log(`\n--- ${title} ---`);
}

/** 打印汇总并按失败数设退出码。**必须每个测试文件结尾调用一次**。
 *  返回失败数，供起了常驻 server 的测试在 `done()` 后 `process.exit()` 用。 */
export function done() {
  console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail}/${pass + fail} 项失败`);
  process.exitCode = fail === 0 ? 0 : 1;
  return fail;
}
