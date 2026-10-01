# Review queue

This folder is the school's **shared staging area**. It is what lets a teacher
upload a resource on one device and an administrator review it on another.

```
submissions/
  queue.json              metadata for every submission awaiting (or finished with) review
  pending/<id>__<file>    the uploaded bytes, held here until an administrator decides
```

Nothing in this folder is part of the public library. `apps.json` only lists
files under `apps/`, so a staged upload is never advertised on the dashboard,
never searchable and never counted.

**Approve** copies the file to `apps/`, adds it to `library.json` and deletes
the staged copy. **Decline** deletes the staged copy and keeps the queue entry
so the teacher can see the reason. **Delete** removes both.

> ⚠️ This repository is public, so a staged file is reachable by anyone who
> knows (or guesses) its URL before it is approved. Approval controls whether a
> resource is *listed in the library*, not whether the bytes are secret. Do not
> stage anything confidential.
