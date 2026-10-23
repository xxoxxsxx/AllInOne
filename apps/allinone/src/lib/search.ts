// 纯搜索逻辑（PRD §5.3）：
// - 忽略大小写与首尾空格；
// - 多个空格分隔的关键词全部匹配，每个词可命中不同字段；
// - 搜索范围：名称、简述、标签、别名；不检索工具业务数据。
// 此文件必须保持自包含（无任何 import），便于 node --test 直接测试。
export interface SearchFields {
  name: string;
  description: string;
  tags: string[];
  aliases: string[];
}

export function matchesQuery(fields: SearchFields, rawQuery: string): boolean {
  const terms = rawQuery
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return true;

  const name = fields.name.toLowerCase();
  const description = fields.description.toLowerCase();
  const tags = fields.tags.map((t) => t.toLowerCase());
  const aliases = fields.aliases.map((t) => t.toLowerCase());

  return terms.every((term) => {
    return (
      name.includes(term) ||
      description.includes(term) ||
      tags.some((t) => t.includes(term)) ||
      aliases.some((t) => t.includes(term))
    );
  });
}
