export interface PtySessionInfo {
    id: number;
    name: string;
}

export type PtyDataHandler = (sessionId: number, data: string) => void;
export type PtyExitHandler = (sessionId: number, exitCode: number, ageMs?: number) => void;

export interface INodePty {
    spawn(
        file: string,
        args: string[],
        options: {
            name?: string;
            cols?: number;
            rows?: number;
            cwd?: string;
            env?: NodeJS.ProcessEnv;
        },
    ): IPtyProcess;
}

export interface IPtyProcess {
    onData(callback: (data: string) => void): void;
    onExit(callback: (event: { exitCode: number }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
}
