# tree-sitter-ghoti

A [tree-sitter](https://tree-sitter.github.io/) grammar for the
[ghoti](https://github.com/trevorswan11/ghoti) programming language.

## Building and testing

```sh
cargo install tree-sitter-cli   # one-time
tree-sitter generate
tree-sitter test                # runs test/corpus/*.txt
```
