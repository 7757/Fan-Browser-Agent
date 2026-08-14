// Public 资源(public/brand/*)的运行时 URL。必须经 import.meta.env.BASE_URL
// 解析:vite 只改写 index.html 里的资源路径,JSX 里硬写的 src="/brand/x.svg"
// 是运行时字符串,vite 不碰它——打包版通过 file:// 加载时,绝对根路径 /brand
// 会指到文件系统根目录导致 404(logo 裂开)。base 为 './' 时 BASE_URL='./',
// 结果相对 index.html 解析,dev(http)与打包(file)两种加载都成立。
export const FAN_LOGO_MARK = `${import.meta.env.BASE_URL}brand/fan-logo-mark.svg`
