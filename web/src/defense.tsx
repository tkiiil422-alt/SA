import { SecurityWorkbench } from './pentest'

/** 应用安全防御与加固工作台（独立入口 #/defense，聚焦代码安全审查、配置基线核查与最小侵入修复）。 */
export function Defense() {
  return <SecurityWorkbench mode="defense" />
}
