import MarkdownIt from 'markdown-it'

// html: false —— 转义原始 HTML，防止注入；各页面统一从这里拿渲染器
const defaultMd = new MarkdownIt({ html: false, linkify: false, breaks: true })

/** 对话 / 文档正文用：换行保留，不自动认链接 */
export const renderMd = (text: string) => defaultMd.render(text)

const kbMd = new MarkdownIt({ html: false, linkify: true, breaks: false })

/** 资料库正文用：标准 Markdown 换行规则，自动识别链接 */
export const renderKbMd = (text: string) => kbMd.render(text)
