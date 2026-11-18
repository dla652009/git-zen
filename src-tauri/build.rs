fn main() {
    // 图标被嵌进 exe 的资源段（Windows）／bundle（macOS），但 tauri-build 只把
    // tauri.conf.json 登记成重编触发条件，**图标文件本身不会**。
    // 后果：换了 icon.ico 之后 `tauri dev` 跑的还是旧图标，而且 cargo 认为
    // 什么都没变，压根不会重编 —— 看起来像「图标没生效」。
    // 这里补上声明，改图标就会触发重编。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    tauri_build::build()
}
