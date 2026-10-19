// help-lib.mjs の型(test/help.test.ts が TS から読むため。tsconfig は allowJs を使わない)
export type HelpSource = { key: string; title: string; summary: string; body: string; line: number };
export type HelpProblem = { line: number; message: string };
export declare const HELP_KEY_RE: RegExp;
export declare const SUMMARY_MAX: number;
export declare function parseHelp(md: string): { entries: HelpSource[]; problems: HelpProblem[] };
export declare function renderInline(text: string): string;
export declare function plainInline(text: string): string;
export declare function renderMarkdown(md: string): string;
export declare function renderHelpModule(entries: HelpSource[], source?: string): string;
