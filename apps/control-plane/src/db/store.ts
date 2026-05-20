import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, Run, RunEvent, Task, TaskStatus, WakeEvent, Workspace } from "@poc/shared";

type StoreData = {
  agents: Agent[];
  workspaces: Workspace[];
  tasks: Task[];
  wakeEvents: WakeEvent[];
  runs: Run[];
  runEvents: RunEvent[];
};

const emptyStore = (): StoreData => ({
  agents: [],
  workspaces: [],
  tasks: [],
  wakeEvents: [],
  runs: [],
  runEvents: [],
});

export class JsonStore {
  private data: StoreData;

  private constructor(
    private readonly filePath: string,
    data: StoreData,
  ) {
    this.data = data;
  }

  static async create(filePath: string): Promise<JsonStore> {
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as StoreData;
      return new JsonStore(filePath, { ...emptyStore(), ...parsed });
    } catch {
      const store = new JsonStore(filePath, emptyStore());
      await store.flush();
      return store;
    }
  }

  async flush() {
    await writeFile(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
  }

  getAgent(id: string) {
    return this.data.agents.find((agent) => agent.id === id);
  }

  async upsertAgent(agent: Agent) {
    this.data.agents = [...this.data.agents.filter((entry) => entry.id !== agent.id), agent];
    await this.flush();
  }

  getWorkspace(id: string) {
    return this.data.workspaces.find((workspace) => workspace.id === id);
  }

  async upsertWorkspace(workspace: Workspace) {
    this.data.workspaces = [...this.data.workspaces.filter((entry) => entry.id !== workspace.id), workspace];
    await this.flush();
  }

  getTask(id: string) {
    return this.data.tasks.find((task) => task.id === id);
  }

  listTasks() {
    return [...this.data.tasks];
  }

  async insertTask(task: Task) {
    this.data.tasks.push(task);
    await this.flush();
  }

  async updateTaskStatus(taskId: string, status: TaskStatus, updatedAt: string) {
    this.data.tasks = this.data.tasks.map((task) => (task.id === taskId ? { ...task, status, updatedAt } : task));
    await this.flush();
  }

  async insertWakeEvent(event: WakeEvent) {
    this.data.wakeEvents.push(event);
    await this.flush();
  }

  getRun(id: string) {
    return this.data.runs.find((run) => run.id === id);
  }

  listRuns() {
    return [...this.data.runs];
  }

  async insertRun(run: Run) {
    this.data.runs.push(run);
    await this.flush();
  }

  async updateRun(run: Run) {
    this.data.runs = this.data.runs.map((entry) => (entry.id === run.id ? run : entry));
    await this.flush();
  }

  async appendRunEvent(event: RunEvent) {
    this.data.runEvents.push(event);
    await this.flush();
  }

  listRunEvents(runId: string) {
    return this.data.runEvents.filter((event) => event.runId === runId);
  }
}
