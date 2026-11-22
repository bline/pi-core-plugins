import { closeSync, fsyncSync, linkSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { absolute, missing, readProfileText, roleName, type Profile } from "./bindings.ts";

export const emptyProfile = JSON.stringify({
  version: 1, repository: "", boardScript: "", python: "/usr/bin/python3", path: ["/usr/bin"], stateDir: "",
  group: "", coordinator: "", members: [], start: "now", suppressSelf: false, maxRows: 128, maxBytes: 1048576,
}, null, 2) + "\n";

export function routing(p: Profile) {
  return {
    repository: p.repository, gitCommonDir: p.common, boardIdentity: { device: p.device, inode: p.inode },
    stateDir: p.stateDir, boardScript: p.script, python: p.python, path: p.env.PATH,
    group: p.group, coordinator: p.coordinator, members: p.members,
    roleTopics: p.members.map(member => `role:${roleName(p.group, member)}`),
    start: p.start, suppressSelf: p.suppressSelf, maxRows: p.maxRows, maxBytes: p.maxBytes,
  };
}

function capture(path: string) {
  const selected = absolute(path, "PI_CHATBOARD_PROFILE");
  const target = join(realpathSync(dirname(selected)), basename(selected));
  let text: string | undefined;
  try { text = readProfileText(target, false); } // Never replace a symlink via the editor.
  catch (e) { if (!missing(e)) throw e; }
  return { target, text };
}

export function profileEdit(path: string) {
  const before = capture(path);
  return {
    target: before.target,
    text: before.text,
    save(text: string) {
      const scratch = mkdtempSync(join(dirname(before.target), ".chatboard-profile-"));
      const tmp = join(scratch, "profile.json");
      try {
        const fd = openSync(tmp, "wx", 0o600);
        try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); }
        finally { closeSync(fd); }
        const current = capture(path);
        if (current.target !== before.target || current.text !== before.text) {
          throw new Error("profile changed while editing; reopen /chatboard setup");
        }
        if (before.text === undefined) linkSync(tmp, before.target); // Fail if another writer created it.
        else renameSync(tmp, before.target); // Replace the whole profile; never edit it in place.
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    },
  };
}
