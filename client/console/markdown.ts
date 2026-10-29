/**
 * 回答里的 Markdown 在终端里怎么显示：模型常用的几样换成终端的写法。
 * 标题与 **加粗** 显示为粗体，`代码` 去掉反引号（终端里显示为青色），> 引用前面加竖线，
 * 代码块去掉围栏、缩进两格，[文字](链接) 显示为「文字（链接）」；列表、表格原样。
 * color 为 false（输出不是终端）时不加控制码，只去掉标记。
 */
export function terminalText(markdown: string, color: boolean): string {
  const style = (code: string, off: string) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[${off}m` : text);
  const bold = style("1", "22");
  const code = style("36", "39");
  const inline = (line: string) =>
    line
      .replace(/`([^`]+)`/g, (_, text: string) => code(text))
      .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a?: string, b?: string) => bold(a ?? b ?? ""))
      .replace(/\[([^\]]+)\]\((\S+?)\)/g, "$1（$2）");

  let fenced = false;
  const lines: string[] = [];
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) lines.push(`  ${code(line)}`);
    else if (/^#{1,6}\s/.test(line)) lines.push(bold(inline(line.replace(/^#+\s+/, ""))));
    else if (/^>\s?/.test(line)) lines.push(`│ ${inline(line.replace(/^>\s?/, ""))}`);
    else lines.push(inline(line));
  }
  return lines.join("\n");
}
