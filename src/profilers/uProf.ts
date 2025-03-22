import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import * as sqlite from "sqlite";
import * as sqlite3 from "sqlite3";
import { IProfiler, StackFrame } from "../iprofiler";

interface CallstackFrame {
        callstackId: string;
        functionId: number;
        depth: number;
}

export class AMDuProf implements IProfiler {
        public async profile(context: vscode.ExtensionContext, exePath: string): Promise<StackFrame | undefined> {
                const cli: string | undefined = this._getCLI();
                if (!cli)
                        return;

                const cwd: string = path.dirname(exePath);
                const out: string = path.join(os.tmpdir(), "uprof");

                // Filled after first Task
                let root: StackFrame | undefined = undefined;
                let translateTask: vscode.Task | undefined = undefined;
                let dir: string | undefined = undefined;
                let done: boolean = false;

                console.info(`Profiling: '${exePath}', cwd: '${cwd}'`)

                const runTask = new vscode.Task(
                        { type: "shell" },
                        vscode.TaskScope.Workspace,
                        "Profile an application",
                        "VSCode Profiler Integration",
                        new vscode.ShellExecution(this._getProfileCommand(cli, cwd, out, exePath))
                );

                const runDisposable = vscode.tasks.onDidEndTaskProcess(async (e) => {
                        if (e.execution.task !== runTask)
                                return;

                        runDisposable.dispose();
                        if (e.exitCode !== 0) {
                                vscode.window.showErrorMessage("Profiler error. Not generating output.");
                                done = true;
                                return;
                        }

                        dir = this._getFirstChildDirectory(out);
                        if (!dir) {
                                vscode.window.showErrorMessage("Profiler did not generate any output.");
                                done = true;
                                return;
                        }

                        translateTask = new vscode.Task(
                                { type: "shell" },
                                vscode.TaskScope.Workspace,
                                "Translate Profiler Output",
                                "VSCode Profiler Integration",
                                new vscode.ShellExecution(this._getTranslateCommand(cli, cwd, dir))
                        );

                        await vscode.tasks.executeTask(translateTask);
                });

                const translateDisposable = vscode.tasks.onDidEndTaskProcess(async (e) => {
                        if (!translateTask || e.execution.task !== translateTask)
                                return;

                        const callstack = path.join(dir!, "callstack.db");
                        const cpu = path.join(dir!, "cpu.db");

                        root = await this._getRoot(context, callstack, cpu);
                        // fs.rmSync(out, { recursive: true, force: true }); // clear the created temp directory
                        done = true;
                });

                await vscode.tasks.executeTask(runTask);

                return new Promise<StackFrame | undefined>((resolve) => {
                        const checkCompletion = () => {
                                if (done)
                                        resolve(root);
                        }

                        const interval = setInterval(() => {
                                checkCompletion();
                                if (done)
                                        clearInterval(interval);

                        }, 100);
                })
        }

        private _getCLI(): string | undefined {
                const cli: string | undefined = vscode.workspace.getConfiguration("vscode.profiler.integration").get<string>("uProfCLIPath");
                if (!cli) {
                        vscode.window.showErrorMessage("AMD uProf CLI executable path not set.");
                        return;
                }

                if (!fs.existsSync(cli) || path.basename(cli) != "AMDuProfCLI.exe") {
                        vscode.window.showErrorMessage("Invalid AMD uProf CLI executable path.");
                        return;
                }

                return cli;
        }

        private _getProfileCommand(cli: string, cwd: string, out: string, exe: string): string {
                return `& '${cli}' collect ` +
                        "--config tbp " +
                        "--timer-interval 1 " +
                        "--call-graph-interval 1 " +
                        "--call-graph-mode fp " +
                        "--call-graph-depth 256 " +
                        "--call-graph-type user " +
                        // "--trace os " +
                        `-w ${cwd} ` +
                        `-o ${out} ` +
                        exe;
        }

        private _getTranslateCommand(cli: string, cwd: string, input: string): string {
                return `& '${cli}' translate ` +
                        "--agg-interval 1024 " +
                        `--symbol-path ${cwd} ` +
                        `-i ${input}`
        }

        private _getFirstChildDirectory(dirPath: string): string | undefined {
                try {
                        const files = fs.readdirSync(dirPath);
                        const directories = files.filter(file => fs.statSync(path.join(dirPath, file)).isDirectory());

                        return directories.length > 0 ? path.join(dirPath, directories[0]) : undefined;
                } catch {
                        return;
                }
        }

        private async _getRoot(context: vscode.ExtensionContext, callstackDbPath: string, cpuDbPath: string): Promise<StackFrame> {
                const db = await sqlite.open({ filename: cpuDbPath, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
                const functions = await this._getFunctions(context, db);
                const callstack = await this._getCallstack(context, db);
                const functionModules = await this._getFunctionModules(context, db);

                const root: StackFrame = { name: "[ROOT]", value: 0, children: [] };
                for (const frames of callstack.values()) {
                        // Sort frames by descending depth so leaf is first
                        frames.sort((a, b) => b.depth - a.depth);

                        let currentNode = root;
                        for (const frame of frames) {
                                let functionName = functions.get(frame.functionId);

                                if (!functionName) {
                                        if (functionModules.get(frame.functionId))
                                                // Use module name if present
                                                functionName = `${functionModules.get(frame.functionId)}!:0x69`
                                        else
                                                functionName = "unknown";
                                }

                                // Check if there's an existing child with the same name
                                let childNode = currentNode.children.find(n => n.name === functionName);
                                if (!childNode) {
                                        childNode = { name: functionName, value: 0, children: [] };
                                        currentNode.children.push(childNode);
                                }

                                // Move 'up' the callstack
                                currentNode = childNode;
                        }

                        // Increment the leaf
                        currentNode.value += 1;
                }

                // Now sum up children to parents
                function aggregateValues(node: StackFrame): number {
                        if (node.children.length === 0)
                                return node.value;

                        node.value = node.children.reduce((acc, c) => acc + aggregateValues(c), 0);
                        return node.value;
                }
                
                aggregateValues(root);
                return root;
        }

        private async _getFunctions(context: vscode.ExtensionContext, db: sqlite.Database): Promise<Map<number, string>> {
                const query = await this._loadSQL(context, "functions.sql");
                const results = await db.all(query);

                const functions = new Map<number, string>();
                results.forEach(({ functionId, moduleId, functionName }) => {
                        functions.set(functionId, functionName);
                });

                return functions;
        }

        private async _getCallstack(context: vscode.ExtensionContext, db: sqlite.Database): Promise<Map<string, Array<CallstackFrame>>> {
                const query = await this._loadSQL(context, "callstack.sql");
                const results = await db.all(query) as CallstackFrame[];

                const callstack = new Map<string, Array<CallstackFrame>>();
                results.forEach(row => {
                        const id = row.callstackId;
                        if (!callstack.has(id)) callstack.set(id, []);
                        callstack.get(id)!.push(row);
                });

                return callstack;
        }

        private async _getFunctionModules(context: vscode.ExtensionContext, db: sqlite.Database): Promise<Map<number, string | undefined>> {
                const query1 = await this._loadSQL(context, "modules.sql");
                const results1 = await db.all(query1);

                const moduleNames = new Map<number, string>();
                results1.forEach(({ moduleId, modulePath }) => {
                        moduleNames.set(moduleId, path.basename(modulePath));
                });

                const query2 = await this._loadSQL(context, "unifiedSampleSeries.sql");
                const results2 = await db.all(query2);

                const functionModules = new Map<number, string | undefined>();
                results2.forEach(({ moduleId, functionId }) => {
                        functionModules.set(functionId, moduleNames.get(moduleId));
                });

                return functionModules;
        }

        private async _loadSQL(context: vscode.ExtensionContext, filePath: string): Promise<string> {
                return fs.promises.readFile(path.join(context.extensionPath, "queries", filePath), "utf8");
        }

}