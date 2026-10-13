import type { Directive } from "vue";

// v-focus：弹层挂载时自动聚焦。
// 值给 false 就不抢焦点 —— 一个弹层里有多个输入框时，只该让第一个自动聚焦。
//
// 为什么放在 lib 而不是 App.vue 的局部指令：浮层正在逐个拆成子组件，
// 而局部指令只在**定义它的那个组件**的模板里有效 —— 拆出去不会报错，
// 只是不再聚焦（静默失效）。全局注册后子组件里 `v-focus` 照用。
//
// 在 src/main.ts 里 `app.directive("focus", vFocus)` 注册。
export const vFocus: Directive<HTMLElement, unknown> = {
  mounted: (el, b) => {
    if (b.value !== false) el.focus();
  },
};
