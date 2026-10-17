import type { QuotaPieService } from "./service";
import { normalizeSessionId } from "./session-discovery";

const HELP = `quotapie goals — read a host goal linked to a registered paused session

  goals link --task TASK_UUID --session THREAD_UUID
  goals list [--refresh]
  goals unlink --task TASK_UUID

For a new Codex paused session, use: quotapie pause --provider codex --goal
Only the linked session's existing host goal is read. No goal or turn is created.
`;

export async function runHostGoalsCommand(args: string[], service: QuotaPieService): Promise<number> {
  const operation = args[0];
  if (!operation || ["help", "--help", "-h"].includes(operation)) { console.log(HELP); return 0; }
  const option = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0 || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(HELP);
    return normalizeSessionId(args[i + 1]!);
  };
  if (operation === "link") {
    console.log(JSON.stringify(await service.linkHostGoal(option("--task"), option("--session")), null, 2));
  } else if (operation === "list") {
    if (args.includes("--refresh")) await service.refreshHostGoals(true);
    console.log(JSON.stringify(service.hostGoalStatus(), null, 2));
  } else if (operation === "unlink") {
    service.unlinkHostGoal(option("--task"));
    console.log(JSON.stringify({ unlinked: true }));
  } else throw new Error(HELP);
  return 0;
}
