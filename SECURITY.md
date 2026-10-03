# Security

Credentials and browser state belong only in private host storage, outside Git. Use a dedicated OS account, mode 0700 directories, mode 0600 files and private browser access. The deployment operator chooses disk encryption; Unix file permissions do not encrypt secrets. Administrators and processes running as the same user can read them.

The OpenClaw shared HTTP token has operator authority. This bridge's sender and chat rules are not an OpenClaw tool authorization boundary. The deployment operator chooses which agent to expose. Routing to an existing main agent deliberately grants every allowed sender its configured tools, skills and shared workspace access. Per-chat history separation does not restrict those capabilities. Choose a dedicated agent/Gateway when senders should have fewer capabilities.

Unexpected Teams records pause a chat. Ambiguous submissions require explicit resolution; retries can duplicate effects. Group context is shared and retained by OpenClaw, whose own session/storage retention is independent of bridge cleanup. Review/reset context when changing group access.

Daemon logs contain event categories rather than bodies, tokens or raw errors. Operator inspection commands expose account/chat metadata deliberately. Private config, browser profile, queue/WAL and backups may contain sensitive material. Do not submit them with bug reports or upload them to CI.

For a suspected credential leak, revoke the Teams session and rotate the configured Gateway token, stop the bridge, and inspect/purge private state. Report vulnerabilities privately to the repository maintainer before opening a public issue; include synthetic reproductions only.
