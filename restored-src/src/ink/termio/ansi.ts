/**
 * 文件：termio/ansi.ts
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件是 termio 子模块的 ANSI 基础常量层，位于整个终端 I/O 体系的最底层。
 * tokenize.ts、csi.ts、osc.ts 等上层模块均依赖此处定义的常量来识别和生成转义序列。
 *
 * 【主要功能】
 * - `C0`：ECMA-48 定义的 7 位 C0 控制字符对象（0x00–0x7f）
 * - `ESC`、`BEL`、`SEP`：用于序列生成的字符串常量
 * - `ESC_TYPE`：ESC 字节之后的序列类型引入字节枚举
 *   （CSI=0x5b、OSC=0x5d、DCS=0x50、APC=0x5f、PM=0x5e、SOS=0x58、ST=0x5c）
 * - `isC0(byte)`：判断字节是否为 C0 控制字符
 * - `isEscFinal(byte)`：判断字节是否为 ESC 序列终止字节
 *
 * 【标准依据】
 * 基于 ECMA-48 / ANSI X3.64 标准。
 */

/**
 * C0（7 位）控制字符常量表。
 *
 * 覆盖 0x00–0x1f 范围的全部控制字符以及 DEL（0x7f）。
 * 这些字节值在 tokenizer 状态机中用于识别序列边界和特殊控制码。
 */
export const C0 = {
  NUL: 0x00, // 空字符
  SOH: 0x01, // 标题开始
  STX: 0x02, // 正文开始
  ETX: 0x03, // 正文结束（Ctrl+C）
  EOT: 0x04, // 传输结束（Ctrl+D）
  ENQ: 0x05, // 查询
  ACK: 0x06, // 确认
  BEL: 0x07, // 响铃
  BS: 0x08,  // 退格
  HT: 0x09,  // 水平制表符
  LF: 0x0a,  // 换行
  VT: 0x0b,  // 垂直制表符
  FF: 0x0c,  // 换页
  CR: 0x0d,  // 回车
  SO: 0x0e,  // 移出（Shift Out）
  SI: 0x0f,  // 移入（Shift In）
  DLE: 0x10, // 数据链路转义
  DC1: 0x11, // 设备控制 1（XON）
  DC2: 0x12, // 设备控制 2
  DC3: 0x13, // 设备控制 3（XOFF）
  DC4: 0x14, // 设备控制 4
  NAK: 0x15, // 否定确认
  SYN: 0x16, // 同步空闲
  ETB: 0x17, // 传输块结束
  CAN: 0x18, // 取消
  EM: 0x19,  // 媒介结束
  SUB: 0x1a, // 替换
  ESC: 0x1b, // 转义（ESC）
  FS: 0x1c,  // 文件分隔符
  GS: 0x1d,  // 组分隔符
  RS: 0x1e,  // 记录分隔符
  US: 0x1f,  // 单元分隔符
  DEL: 0x7f, // 删除（DEL）
} as const

// 输出生成用的字符串常量
/** ESC 转义字符（0x1b），所有 ANSI 转义序列的起始字符 */
export const ESC = '\x1b'
/** BEL 响铃字符（0x07），用于 OSC 序列终止和通知 */
export const BEL = '\x07'
/** 参数分隔符（分号），用于 CSI/OSC 序列中分隔多个参数 */
export const SEP = ';'

/**
 * ESC 字节之后的序列类型引入字节枚举。
 *
 * 终端解析器看到 ESC（0x1b）后，根据紧随其后的字节
 * 判断所属序列类型并进入对应的解析状态。
 *
 * 对应关系：
 * - CSI (0x5b = '[')：控制序列引入符，光标移动、SGR 等
 * - OSC (0x5d = ']')：操作系统命令，标题、超链接等
 * - DCS (0x50 = 'P')：设备控制字符串，XTVERSION 响应等
 * - APC (0x5f = '_')：应用程序命令
 * - PM  (0x5e = '^')：隐私消息
 * - SOS (0x58 = 'X')：字符串起始
 * - ST  (0x5c = '\\')：字符串终止符，用于终止 DCS/OSC/APC 等
 */
export const ESC_TYPE = {
  CSI: 0x5b, // [ - Control Sequence Introducer（控制序列引入符）
  OSC: 0x5d, // ] - Operating System Command（操作系统命令）
  DCS: 0x50, // P - Device Control String（设备控制字符串）
  APC: 0x5f, // _ - Application Program Command（应用程序命令）
  PM: 0x5e,  // ^ - Privacy Message（隐私消息）
  SOS: 0x58, // X - Start of String（字符串起始）
  ST: 0x5c,  // \ - String Terminator（字符串终止符）
} as const

/**
 * 判断字节是否为 C0 控制字符。
 *
 * C0 范围：0x00–0x1f（包含 ESC、BEL 等控制码）以及 DEL（0x7f）。
 * 在 tokenizer 中用于判断文本 token 中是否包含需要特殊处理的控制字符。
 *
 * @param byte 待检测的字节值（0–255）
 * @returns 若为 C0 控制字符则返回 true
 */
export function isC0(byte: number): boolean {
  return byte < 0x20 || byte === 0x7f
}

/**
 * 判断字节是否为 ESC 序列的终止字节。
 *
 * ESC 序列终止字节范围：0x30–0x7e（即 '0'–'~'），
 * 比 CSI 的终止字节范围更宽，包含数字和部分标点。
 * 用于 tokenizer 识别简单两字节 ESC 序列（如 ESC c、ESC 7 等）的结束位置。
 *
 * @param byte 待检测的字节值
 * @returns 若为有效 ESC 序列终止字节则返回 true
 */
export function isEscFinal(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x7e
}
