'use strict';

/* 熔断分诊（2026-10-15 Alvin 定）：熔断只为环境病（凭据过期/磁盘/网络的「起跑即挂」）设计，
 * 闸类拦截不是环境病，不该喂熔断。theme-text-edit 与 redirect-add 两轮实证：方案契约校验
 * （undeclared ops）是零 spawn 的确定性失败，三连挂把整个 worker 停数小时，纯误伤。
 *
 * 三种裁决：
 *   count — 计入连续秒挂计数（真失败且跑得快，环境病嫌疑）
 *   reset — 清零计数（跑满 90 秒的失败是任务病不是环境病；用户取消是人的意志）
 *   skip  — 不计也不清（闸类拦截对环境健康零信息量，计数原样保留，
 *           免得登录过期的连挂序列被夹在中间的闸拦截洗白）
 */
function fuseVerdict({ gate, runMs, cancelled }) {
  if (cancelled) return 'reset';
  if (gate) return 'skip';
  return runMs < 90000 ? 'count' : 'reset';
}

module.exports = { fuseVerdict };
