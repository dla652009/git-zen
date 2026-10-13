// IME 守卫：输入法组词期间，Enter / Esc 属于输入法，不该触发弹窗动作。
//
// 必须监听 `keydown`。Chromium 里，确认候选词那一次 `keyup` 的 `e.isComposing`
// 已经变回 false —— 只在 keyup 上判断等于没判。
//
// 用法：在 `<script setup>` 里包出**常量**，模板里写裸标识符：
//   const imeConfirm = imeGuard(confirm);
//   <input @keydown.enter.prevent="imeConfirm" />
// 不要在模板里写内联的 `imeGuard(fn)` —— 它返回的是函数，作为内联语句会被丢掉。
//
// 为什么放在 lib 而不是 App.vue：浮层正在逐个拆成子组件，子组件自带一份实现
// 迟早会漂移（漏一处就是「组词时回车把弹窗提交了」）；共用一份，改也只改一处。
export function imeGuard(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.isComposing) return; // 组词中：Enter/Esc 交给输入法
    fn();
  };
}
