# Upstream references

The MVP uses the published `apache/answer:2.0.2` image. No Answer modifications or answer-cli dependency are required.

| Submodule | Fork | Revision |
| --- | --- | --- |
| `answer/` | https://github.com/tdyin/answer | `3b9f1370612e690a0b7f230f05e688930db4c6d3` (v2.0.2) |
| `answer-cli/` | https://github.com/tdyin/answer-cli | `a4666c48fba5970cc7bcef5616afb7aa0e444b11` |

Run `git submodule update --init --recursive` after cloning. Both forks remain unmodified. The CLI's stdio MCP server is available for future development; the default stack runs the custom HTTP adapter.

When changing Answer, explicitly build/select a fork image and verify the REST contract before updating its source pin. Compose currently uses the published image, not a build of this checkout.
