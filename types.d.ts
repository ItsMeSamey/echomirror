declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  cwd(): string;
  exitCode?: number;
  stderr: {
    isTTY?: boolean;
    columns?: number;
    write(value: string): void;
  };
};

declare module 'node:fs' {
  export const appendFileSync: any;
  export const writeFileSync: any;
  export const readFileSync: any;
  export const createWriteStream: any;
  export const existsSync: any;
  export const statSync: any;
  export const mkdirSync: any;
  export const rmSync: any;
  export const renameSync: any;
  export const readdirSync: any;
  export const rmdirSync: any;
}

declare module 'node:path' {
  const path: any;
  export default path;
}

declare module 'node:os' {
  const os: any;
  export default os;
}

declare module 'node:child_process' {
  export const spawn: any;
}

declare module 'node:stream/promises' {
  export const pipeline: any;
}

declare module 'node:crypto' {
  export const createHash: any;
}
