# tree-sitter-ghoti

A [tree-sitter](https://tree-sitter.github.io/) grammar for the
[ghoti](https://github.com/trevorswan11/ghoti) programming language, written for use in the Zed
editor extension at `../ghoti-zed-extension`.

This is a **highlighting-grade** grammar: it's grounded directly in the real compiler's
lexer/keywords/operators/AST (see the header comment in `grammar.js` for exact source files), but
it does not aim to be a perfect semantic re-implementation of the compiler's own parser — only
accurate enough to tokenize and structure real ghoti source correctly for editor
highlighting/indentation.

## Building and testing

```sh
cargo install tree-sitter-cli   # one-time
tree-sitter generate
tree-sitter test                # runs test/corpus/*.txt
```

## Known limitation

Ghoti requires a trailing `;` after every statement, including block-like ones (`if`/`while`/
`for`/`match`/etc.) — except when the statement's last branch already self-terminates (a nested
`return b;`, or ends in a bare `}` block), in which case the real compiler tolerates omitting the
outer `;`. Modeling that precisely (which branch already "counts" as terminated) introduced more
structural grammar ambiguity than it was worth. This grammar always requires the trailing `;`;
where real code omits it in that specific way, tree-sitter's own error recovery synthesizes a
`MISSING ";"` node rather than failing — the resulting tree is still complete and correct (unlike
a genuine `ERROR` node), so this doesn't affect highlighting. Verified via `tree-sitter parse`
against `test/golden.gh` (the exhaustive kitchen-sink source from the compiler's own
`ast/test_dumper.cc` test) and `test/comments.gh`: zero `ERROR` nodes in either, only this one
documented `MISSING ";"` pattern. These two files are kept as spot-check fixtures rather than in
`test/corpus/` (which requires byte-for-byte clean parses to pass `tree-sitter test`).
