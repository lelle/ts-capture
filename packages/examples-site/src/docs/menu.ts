export interface MenuPage {
  name: string;
  file: string;
}

export interface MenuGroup {
  name: string;
  pages: MenuPage[];
}

const GROUPS_START = "## The four kinds of docs";

/** The groups under the four kinds in docs/README.md, and the pages each lists. */
export function readMenu(readme: string): MenuGroup[] {
  const groups: MenuGroup[] = [];
  const start = readme.indexOf(GROUPS_START);
  for (const line of readme.slice(start).split("\n")) {
    const group = /^### (.+?)(?: — .*)?$/.exec(line);
    if (group) groups.push({ name: group[1]!, pages: [] });
    const page = /^- \[([^\]]+)\]\(([^)#]+\.md)\)/.exec(line);
    if (page && groups.length > 0) {
      groups.at(-1)!.pages.push({ name: page[1]!, file: page[2]! });
    }
  }
  return groups;
}
