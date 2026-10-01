const PREC = {
  ASSIGN: 1,
  RANGE: 2,
  OR: 3,
  AND: 4,
  COMPARE: 5,
  BW_OR: 6,
  BW_XOR: 7,
  BW_AND: 8,
  SHIFT: 9,
  ADD: 10,
  MUL: 11,
  UNARY: 12,
  CALL: 13,
  FIELD: 14,
};

module.exports = grammar({
  name: "ghoti",

  extras: ($) => [/\s/, $.comment, $.doc_comment, $.module_doc_comment],

  word: ($) => $.identifier,

  conflicts: ($) => [
    [$._type, $._expression],
    [$._type, $.array_expression],
    [$.expression_statement, $._expression, $._if_branch],
    [$.expression_statement, $._if_branch],
    [$.initializer_expression, $._if_branch],
    [$.extern_modifier, $.struct_expression],
    [$._expression, $.labeled_expression],
    [$.labeled_statement, $._expression, $.labeled_expression],
    [$._expression, $.expression_statement],
    [$.modified_type, $.pointer_type],
    [$.modified_type, $.reference_type],
    [$.block, $.asm_expression],
    [$.function_type, $._fn_header],
    [$._field_cfg_body, $._member_cfg_body],
    [$._enumerator_cfg_body, $._member_cfg_body],
    [$.cfg_statement],
    [$.function_expression],
    [$.dyn_type, $._expression],
    [$.dyn_type, $.dyn_function_type, $._expression],
    [$.parenthesized_expression, $.if_expression],
    [$.parameter],
  ],

  rules: {
    source_file: ($) => repeat($._statement),

    // `//!` (module doc) and `///` (doc) are re-tagged variants of a plain `//` comment; all
    // three share a prefix so ties are broken by precedence (mirrors lexer.cc's classify_comment).
    comment: (_) => token(prec(1, seq("//", /[^\n]*/))),
    doc_comment: (_) => token(prec(2, seq("///", /[^\n]*/))),
    module_doc_comment: (_) => token(prec(3, seq("//!", /[^\n]*/))),

    // ---------------------------------------------------------------- statements

    _statement: ($) =>
      choice(
        $.decl_statement,
        $.import_statement,
        $.defer_statement,
        $.errdefer_statement,
        $.break_statement,
        $.continue_statement,
        $.return_statement,
        $.discard_statement,
        $.test_statement,
        $.impl_statement,
        $.cfg_statement,
        $.labeled_statement,
        $.expression_statement,
      ),

    block: ($) => seq("{", repeat($._statement), "}"),

    labeled_statement: ($) =>
      seq(field("label", $.identifier), ":", choice($.block, $._expression), ";"),

    // `@cfg(pred) <body> [else @cfg(pred) <body>]* [else <body>]?`, usable anywhere a
    // statement can appear.
    cfg_predicate: ($) => seq("@cfg", "(", field("predicate", $._expression), ")"),

    _cfg_body: ($) => $._statement,

    cfg_statement: ($) =>
      prec.right(
        seq(
          $.cfg_predicate,
          field("consequence", $._cfg_body),
          repeat(seq("else", $.cfg_predicate, field("consequence", $._cfg_body))),
          optional(seq("else", field("alternate", $._cfg_body))),
        ),
      ),

    _decl_modifier: ($) =>
      choice(
        "pub",
        $.extern_modifier,
        $.export_modifier,
        "threadlocal",
        "weak",
      ),

    // `@[name, name(args...), ...]` ahead of a declaration, field, interface method, or
    // function literal; a trailing comma asks the formatter to keep it on its own line.
    attribute_list: ($) => seq("@[", sepBy1(",", $.attribute), optional(","), "]"),

    attribute: ($) => seq(field("name", $.identifier), optional($.arguments)),

    // `extern` / `extern("lib")` / `extern("lib", "sym")`
    extern_modifier: ($) =>
      seq(
        "extern",
        optional(
          seq(
            "(",
            field("target", $.string_literal),
            optional(seq(",", field("link_name", $.string_literal))),
            ")",
          ),
        ),
      ),

    // `export` / `export("sym")`
    export_modifier: ($) =>
      seq("export", optional(seq("(", field("link_name", $.string_literal), ")"))),

    decl_statement: ($) =>
      seq(
        optional(field("attributes", $.attribute_list)),
        repeat($._decl_modifier),
        // `comptime let mut` is the one compile-time-mutable form, and only a local
        field("kind", choice("const", "let", seq("let", "mut"), seq("comptime", "let", "mut"))),
        field("name", $.identifier),
        optional(seq(":", field("type", $._type))),
        optional(seq(choice(":=", "="), field("value", $._value))),
        ";",
      ),

    // A value slot that may also hold a type with no expression spelling, e.g.
    // `const Bytes := []u8;`, `const Any := &dyn Writer;`, or `return [n]T;`. Where both readings
    // parse (`^i32`), the expression wins.
    _value: ($) =>
      choice(
        $._expression,
        prec.dynamic(-1, prec(-1, $.array_type)),
        prec.dynamic(-1, $.pointer_type),
        prec.dynamic(-1, $.reference_type),
        $.dyn_type,
        $.dyn_function_type,
      ),

    import_statement: ($) =>
      seq(
        optional("pub"),
        "import",
        field("path", choice($.string_literal, $.identifier)),
        optional(seq("as", field("alias", $.identifier))),
        ";",
      ),

    // `_ = expr;`: evaluates `expr` and discards the result (silences an unused-value error).
    discard_statement: ($) => seq("_", "=", field("value", $._expression), ";"),

    defer_statement: ($) => seq("defer", field("body", $._statement_body)),

    // `errdefer <stmt>` / `errdefer |err| <stmt>` (also `|^err|`, `|&err|`, `|_|`): deferred
    // cleanup that only runs on the error-propagation edge (a `?` unwrap).
    errdefer_statement: ($) =>
      seq(
        "errdefer",
        optional(
          seq(
            "|",
            optional(choice("&", "^", seq("&", "mut"), seq("^", "mut"))),
            field("capture", choice($.identifier, "_")),
            "|",
          ),
        ),
        field("body", $._statement_body),
      ),
    break_statement: ($) =>
      seq("break", optional(seq(":", field("label", $.identifier))), optional($._expression), ";"),
    continue_statement: ($) =>
      seq("continue", optional(seq(":", field("label", $.identifier))), ";"),
    return_statement: ($) => seq("return", optional($._value), ";"),

    test_statement: ($) =>
      seq("test", optional(field("description", $.string_literal)), field("body", $.block)),

    // `impl I for T { ... }` / `impl T { ... }` / `impl(P: type, ...) [I for] T { ... }`
    // A pure statement, no trailing `;`, like `test { ... }`.
    impl_statement: ($) =>
      seq(
        "impl",
        optional($.impl_parameters),
        field("type", $._type),
        optional(seq("for", field("target", $._type))),
        field("body", $.impl_body),
      ),

    impl_parameters: ($) => seq("(", sepBy(",", $.impl_parameter), optional(","), ")"),

    impl_parameter: ($) =>
      seq(optional("comptime"), field("name", $.identifier), ":", field("type", $._type)),

    impl_body: ($) => seq("{", repeat($._member), "}"),

    _statement_body: ($) => $._statement,

    expression_statement: ($) =>
      choice(
        seq($._expression, ";"),
        $.if_expression,
        $.match_expression,
        $.for_expression,
        $.while_expression,
        $.do_while_expression,
        $.loop_expression,
        $.labeled_expression,
        $.comptime_expression,
        $.block,
      ),

    // ---------------------------------------------------------------- types

    _type: ($) =>
      choice(
        $.pointer_type,
        $.reference_type,
        $.array_type, // also covers slice types `[]T` (empty size)
        $.function_type,
        $.dyn_type,
        $.dyn_function_type,
        $.impl_type,
        $.primitive_type,
        $.identifier,
        $.dot_expression, // e.g. std.ArrayList, std.os.Errno
        $.call_expression, // e.g. std.ArrayList(u8)
        $.struct_expression,
        $.union_expression,
        $.enum_expression,
        $.interface_expression,
        $.builtin_call_expression, // e.g. @this()
        $.modified_type, // bare `mut`/`volatile` prefix, e.g. `let mut v: mut volatile i32;`
      ),

    // Recursive so `mut volatile T` is just two nested modified_types
    modified_type: ($) => prec.right(seq(choice("mut", "volatile"), field("inner", $._type))),

    pointer_type: ($) => prec.right(seq("^", optional("mut"), field("inner", $._type))),
    reference_type: ($) => prec.right(seq("&", optional("mut"), field("inner", $._type))),
    array_type: ($) =>
      seq(
        "[",
        field("size", optional($._expression)),
        optional(":0"),
        "]",
        field("inner", $._type),
      ),

    // `dyn I` / `dyn mod.I` / `dyn I(Assoc = T, ...)`; wrapped as `&dyn I` / `^dyn I` via
    // reference/pointer types since `dyn` sits where a type normally would.
    dyn_type: ($) =>
      seq(
        "dyn",
        field("interface", choice($.identifier, $.dot_expression)),
        optional($.dyn_assoc_bindings),
      ),

    // `dyn Fn(n: i32): R` is sugar for the erased `fn(n: i32): R`; `Fn` stays a plain identifier so
    // a user `interface Fn` still parses as a `dyn_type`, told apart by `name:` vs `name =`.
    dyn_function_type: ($) =>
      seq(
        "dyn",
        field("name", $.identifier),
        "(",
        sepBy(",", $.parameter),
        optional(","),
        ")",
        optional($.callconv),
        ":",
        field("return_type", $._type),
      ),

    dyn_assoc_bindings: ($) => seq("(", sepBy(",", $.dyn_assoc_binding), optional(","), ")"),

    dyn_assoc_binding: ($) => seq(field("name", $.identifier), "=", field("type", $._type)),

    // `impl I` / `impl (A + B)` parameter-position sugar.
    impl_type: ($) =>
      seq("impl", choice($._type, seq("(", sepByPlus($._type), ")"))),

    // Optional `callconv(.name)` between a function header's `)` and its return type.
    callconv: ($) => seq("callconv", "(", field("convention", $.calling_convention), ")"),

    calling_convention: (_) =>
      seq(".", choice("c", "sysv", "win64", "stdcall", "fastcall", "aapcs")),

    // Every non-variadic parameter must be named (`fn(x: i32, done: ^bool): void`), not bare
    // types; the return type is mandatory. `extern fn` is the thin, C-ABI code pointer.
    function_type: ($) =>
      seq(
        optional("extern"),
        "fn",
        "(",
        sepBy(",", choice($.parameter, "...")),
        optional(","),
        ")",
        optional($.callconv),
        ":",
        field("return_type", $._type),
      ),

    primitive_type: ($) =>
      choice(
        $._sized_integer_type,
        "isize",
        "usize",
        "f16",
        "f32",
        "f64",
        "f80",
        "f128",
        "comptime_int",
        "comptime_float",
        "bool",
        "void",
        "type",
        "auto",
        "opaque",
        "noreturn",
      ),

    // Arbitrary-width integers: `u123`, `i3343`, etc. (width 1..65535, no leading zero).
    _sized_integer_type: (_) => token(prec(2, /[iu][1-9][0-9]*/)),

    // ---------------------------------------------------------------- expressions

    _expression: ($) =>
      choice(
        $.identifier,
        $.integer_literal,
        $.float_literal,
        $.string_literal,
        $.multiline_string_literal,
        $.char_literal,
        $.boolean_literal,
        $.undefined_literal,
        $.unreachable_literal,
        $.nullptr_literal,
        $.builtin_call_expression,
        $.cfg_value_guard_call,
        $.call_expression,
        $.index_expression,
        $.dot_expression,
        $.implicit_access_expression,
        $.initializer_expression,
        $.array_expression,
        $.unary_expression,
        $.dereference_expression,
        $.reference_expression,
        $.address_of_expression,
        $.binary_expression,
        $.assignment_expression,
        $.range_expression,
        $.unwrap_expression,
        $.function_expression,
        $.struct_expression,
        $.union_expression,
        $.enum_expression,
        $.interface_expression,
        $.asm_expression,
        $.if_expression,
        $.match_expression,
        $.for_expression,
        $.while_expression,
        $.do_while_expression,
        $.loop_expression,
        $.labeled_expression,
        $.comptime_expression,
        $.block,
        $.parenthesized_expression,
      ),

    // `comptime { ... }` / `comptime label: { ... }`: a compile-time-evaluated block usable as
    // a statement or, labeled, as a `break`-able value expression. `comptime <expr>` forces one
    // expression to be evaluated at compile time and binds like a prefix operator.
    comptime_expression: ($) =>
      choice(
        prec(
          PREC.FIELD + 1,
          seq("comptime", optional(seq(field("label", $.identifier), ":")), field("body", $.block)),
        ),
        prec(PREC.UNARY, seq("comptime", field("operand", $._expression))),
      ),

    // `@cfgValue(pred => val, ..., _ => fallback)`: the guard-arm form. The plain single-argument
    // form `@cfgValue(x)` is just an ordinary builtin_call_expression.
    cfg_value_guard_call: ($) =>
      seq(
        field("function", alias("@cfgValue", $.builtin_identifier)),
        "(",
        sepBy1(",", $.cfg_guard_arm),
        optional(","),
        ")",
      ),

    cfg_guard_arm: ($) =>
      seq(
        field("predicate", choice($._expression, "_")),
        "=>",
        field("value", $._expression),
      ),

    labeled_expression: ($) =>
      prec.right(
        seq(
          field("label", $.identifier),
          ":",
          field(
            "body",
            choice(
              $.block,
              $.loop_expression,
              $.for_expression,
              $.while_expression,
              $.do_while_expression,
            ),
          ),
        ),
      ),

    parenthesized_expression: ($) => seq("(", $._expression, ")"),

    underscore: (_) => "_",
    boolean_literal: (_) => choice("true", "false"),
    undefined_literal: (_) => "undefined",
    unreachable_literal: (_) => "unreachable",
    nullptr_literal: (_) => "nullptr",

    // Lexeme shape mirrors lexer.cc's read_number(): digits (with optional 0x/0b/0o prefix),
    // optional `.` fraction, optional exponent, optional suffix. A suffix is triggered by one of
    // `uUiIzZlLfF` and then greedily consumes `[A-Za-z0-9]*`; widths are now arbitrary
    // (`u123`, `i3343`, `uz`) rather than the old fixed `u`/`l`/`ul` set (though `l`/`L` lexes as
    // a (now-rejected) suffix shape too, since the lexer doesn't validate it). A suffix starting
    // `f`/`F` -- or a `.` fraction, or an exponent -- makes the literal a float instead.
    integer_literal: (_) =>
      token(
        choice(
          seq(/0[xX][0-9a-fA-F_]+/, optional(seq(/[uUiIzZlL]/, /[A-Za-z0-9]*/))),
          seq(/0[bB][01_]+/, optional(seq(/[uUiIzZlL]/, /[A-Za-z0-9]*/))),
          seq(/0[oO][0-7_]+/, optional(seq(/[uUiIzZlL]/, /[A-Za-z0-9]*/))),
          seq(/[0-9][0-9_]*/, optional(seq(/[uUiIzZlL]/, /[A-Za-z0-9]*/))),
        ),
      ),

    // Float suffix is `f`/`F` + width digits (`f32`, `f64`, `f16`, `f128`, `f80`); a bare
    // `f`-suffixed integer (no `.`) is also a float, as is an exponent with no `.`. Hex floats
    // (`0x1.8p3`, `0x1p-4`, `0xA.8`) take a decimal `p` exponent, and since `f` is a hex digit
    // their suffix can only follow that exponent.
    float_literal: (_) =>
      token(
        choice(
          seq(
            /0[xX][0-9a-fA-F][0-9a-fA-F_]*/,
            ".",
            /[0-9a-fA-F][0-9a-fA-F_]*/,
            optional(seq(/[pP][+-]?[0-9][0-9_]*/, optional(seq(/[uUiIzZlLfF]/, /[A-Za-z0-9]*/)))),
          ),
          seq(
            /0[xX][0-9a-fA-F][0-9a-fA-F_]*/,
            /[pP][+-]?[0-9][0-9_]*/,
            optional(seq(/[uUiIzZlLfF]/, /[A-Za-z0-9]*/)),
          ),
          seq(
            /[0-9][0-9_]*/,
            ".",
            /[0-9][0-9_]*/,
            optional(/[eE][+-]?[0-9]+/),
            optional(seq(/[uUiIzZlLfF]/, /[A-Za-z0-9]*/)),
          ),
          seq(/[0-9][0-9_]*/, /[eE][+-]?[0-9]+/, optional(seq(/[uUiIzZlLfF]/, /[A-Za-z0-9]*/))),
          seq(/[0-9][0-9_]*/, seq(/[fF]/, /[A-Za-z0-9]*/)),
        ),
      ),

    // Escapes are their own nodes so highlighting can tell them apart from the text
    string_literal: ($) =>
      seq('"', repeat(choice($._string_content, $.escape_sequence)), token.immediate('"')),

    _string_content: (_) => token.immediate(prec(1, /[^"\\\n]+/)),

    // `\n`-style escapes, `\xHH` for one byte, and `\u{H...}` for a Unicode scalar value
    escape_sequence: (_) =>
      token.immediate(
        seq("\\", choice(/[nrt\\'"0]/, /x[0-9A-Fa-f]{2}/, /u\{[0-9A-Fa-f]{1,6}\}/)),
      ),

    // A `\\`-prefixed line, optionally continued by further `\\`-prefixed lines. Continuation
    // markers may be indented; the leading indentation and marker are not part of the value.
    multiline_string_literal: (_) =>
      token(
        seq(
          "\\\\",
          /[^\n]*/,
          repeat(seq("\n", /[ \t]*/, "\\\\", /[^\n]*/)),
        ),
      ),

    // One code point or one escape
    char_literal: (_) =>
      token(
        seq(
          "'",
          choice(
            /[^'\\\n\r]/,
            seq("\\", choice(/[nrt\\'"0]/, /x[0-9A-Fa-f]{2}/, /u\{[0-9A-Fa-f]{1,6}\}/)),
          ),
          "'",
        ),
      ),

    // A bare word, or a raw identifier `@"..."` letting any text (including reserved keywords)
    // stand in for a name.
    identifier: (_) =>
      token(
        choice(
          /[A-Za-z_][A-Za-z0-9_]*/,
          seq(
            '@"',
            repeat(
              choice(
                /[^"\\\n\r]/,
                seq("\\", choice(/[nrt\\'"0]/, /x[0-9A-Fa-f]{2}/, /u\{[0-9A-Fa-f]{1,6}\}/)),
              ),
            ),
            '"',
          ),
        ),
      ),

    // Right after `.` a keyword is a name: `.weak`, `x.type`
    _member_name: ($) =>
      choice(
        $.identifier,
        alias(
          choice(
            "fn",
            "let",
            "const",
            "comptime",
            "struct",
            "enum",
            "union",
            "true",
            "false",
            "if",
            "else",
            "do",
            "match",
            "return",
            "defer",
            "errdefer",
            "loop",
            "for",
            "while",
            "continue",
            "break",
            "import",
            "bool",
            "void",
            "type",
            "auto",
            "opaque",
            "as",
            "pub",
            "extern",
            "export",
            "threadlocal",
            "weak",
            "callconv",
            "volatile",
            "mut",
            "move",
            "packed",
            "noreturn",
            "nullptr",
            "test",
            "impl",
            "interface",
            "dyn",
            "asm",
            "undefined",
            "unreachable",
          ),
          $.identifier,
        ),
      ),

    builtin_call_expression: ($) =>
      seq(field("function", alias(/@[A-Za-z_][A-Za-z0-9_]*/, $.builtin_identifier)), $.arguments),

    arguments: ($) =>
      seq("(", sepBy(",", choice($._expression, $._type, $.pack_expansion)), optional(","), ")"),

    // `f(rest...)`: forwards a parameter pack in place, one per call argument.
    pack_expansion: ($) => seq(field("value", $._expression), "..."),

    call_expression: ($) =>
      prec(PREC.CALL, seq(field("function", $._expression), field("arguments", $.arguments))),

    index_expression: ($) =>
      prec(PREC.CALL, seq(field("array", $._expression), "[", field("index", $._expression), "]")),

    dot_expression: ($) =>
      prec(PREC.FIELD, seq(field("object", $._expression), ".", field("member", $._member_name))),

    implicit_access_expression: ($) => prec(PREC.FIELD, seq(".", field("member", $._member_name))),

    initializer_expression: ($) =>
      choice(
        // Anonymous `.{ .a = 1 }` -- the leading `.` has no member, must not be confused with
        // implicit_access_expression's own `.member` shorthand
        seq(".", "{", sepBy(",", $._initializer_item), optional(","), "}"),
        seq(field("type", $._expression), "{", sepBy(",", $._initializer_item), optional(","), "}"),
      ),

    // Named `.field = value` or positional `value` (array-style / `Alias{ a, b, c }`) entry.
    _initializer_item: ($) => choice($.field_initializer, $._expression),

    // Precedence above PREC.FIELD so `.name =` shifts into a field initializer instead of
    // reducing `.name` as a standalone implicit_access_expression first.
    field_initializer: ($) =>
      prec(PREC.FIELD + 1, seq(".", field("name", $._member_name), "=", field("value", $._expression))),

    array_expression: ($) =>
      seq(field("array_type", $.array_type), "{", sepBy(",", $._expression), optional(","), "}"),

    unary_expression: ($) =>
      prec(PREC.UNARY, seq(field("operator", choice("!", "~", "-", "+")), field("operand", $._expression))),

    dereference_expression: ($) => prec(PREC.UNARY, seq("*", field("operand", $._expression))),
    reference_expression: ($) =>
      prec(PREC.UNARY, seq("&", optional("mut"), field("operand", $._expression))),
    address_of_expression: ($) =>
      prec(PREC.UNARY, seq("^", optional("mut"), field("operand", $._expression))),

    // Postfix `?` / `!` unwrap operators for `Result` / `Optional`.
    unwrap_expression: ($) =>
      prec.left(PREC.CALL, seq(field("operand", $._expression), field("operator", choice("?", "!")))),

    binary_expression: ($) => {
      const table = [
        [PREC.OR, "or"],
        [PREC.AND, "and"],
        [PREC.COMPARE, choice("<", "<=", ">", ">=", "==", "!=")],
        [PREC.BW_OR, "|"],
        [PREC.BW_XOR, "^"],
        [PREC.BW_AND, "&"],
        [PREC.SHIFT, choice("<<", ">>", "<<%", "<<|")],
        [PREC.ADD, choice("+", "-", "+%", "-%", "+|", "-|")],
        [PREC.MUL, choice("*", "/", "%", "*%", "*|")],
      ];
      return choice(
        ...table.map(([precedence, operator]) =>
          prec.left(
            precedence,
            seq(field("left", $._expression), field("operator", operator), field("right", $._expression)),
          ),
        ),
      );
    },

    assignment_expression: ($) =>
      prec.right(
        PREC.ASSIGN,
        seq(
          field("left", $._expression),
          field(
            "operator",
            choice(
              "=",
              "+=",
              "+%=",
              "+|=",
              "-=",
              "-%=",
              "-|=",
              "*=",
              "*%=",
              "*|=",
              "/=",
              "%=",
              "&=",
              "|=",
              "^=",
              "<<=",
              "<<%=",
              "<<|=",
              ">>=",
              "~=",
            ),
          ),
          field("right", $._expression),
        ),
      ),

    // All four combinations of optional start/end: `..`, `..hi`, `..=hi`, `lo..`, `lo..=hi`.
    range_expression: ($) =>
      prec.left(
        PREC.RANGE,
        choice(
          seq(
            field("start", $._expression),
            field("operator", choice("..", "..=")),
            optional(field("end", $._expression)),
          ),
          seq(field("operator", choice("..", "..=")), optional(field("end", $._expression))),
        ),
      ),

    // -------------------------------------------------------------- functions

    self_parameter: ($) =>
      seq(optional(choice("&", "^", seq("&", "mut"), seq("^", "mut"))), choice("self", "this")),

    // `x: T`, an untyped pack `rest...`, a bound pack `rest: impl I...`, or `comptime n: T`.
    parameter: ($) =>
      seq(
        optional("comptime"),
        field("name", $.identifier),
        choice(
          seq(":", field("type", $._type), optional(prec.dynamic(1, field("pack", "...")))),
          field("pack", "..."),
        ),
      ),

    // Shared header: `(self?, params..., ...?) callconv(.x)? : return_type?`
    _fn_header: ($) =>
      seq(
        "(",
        optional(seq($.self_parameter, optional(","))),
        sepBy(",", $.parameter),
        optional(seq(optional(","), "...")),
        optional(","),
        ")",
        optional($.callconv),
        ":",
        field("return_type", $._type),
      ),

    // A bodyless `fn(...): T` is a function-typed value (e.g. usable as a `T: type` argument,
    // an interface method's signature, or a plain function-pointer-typed const). Prefer
    // consuming a trailing `{ ... }` as the body whenever one is present.
    function_expression: ($) =>
      choice(
        seq(
          optional(field("attributes", $.attribute_list)),
          optional("move"),
          "fn",
          $._fn_header,
          field("body", $.block),
        ),
        prec.dynamic(-1, seq(optional(choice("move", "extern")), "fn", $._fn_header)),
      ),

    // -------------------------------------------------------------- struct/union/enum

    _member: ($) => choice($.decl_statement, $.import_statement),

    // `@cfg(pred) <one member or { member* }> [else @cfg(...) ...]* [else ...]?`
    member_cfg_group: ($) =>
      seq(
        $.cfg_predicate,
        field("consequence", $._member_cfg_body),
        repeat(seq("else", $.cfg_predicate, field("consequence", $._member_cfg_body))),
        optional(seq("else", field("alternate", $._member_cfg_body))),
      ),
    _member_cfg_body: ($) => choice($._member, seq("{", repeat($._member), "}")),

    field_declaration: ($) =>
      seq(
        optional(field("attributes", $.attribute_list)),
        optional("pub"),
        field("name", $.identifier),
        ":",
        field("type", $._type),
        optional(seq("=", field("default", $._expression))),
      ),

    // `@cfg(pred) <one field or { field, ... }> [else @cfg(...) ...]* [else ...]?`
    field_cfg_group: ($) =>
      seq(
        $.cfg_predicate,
        field("consequence", $._field_cfg_body),
        repeat(seq("else", $.cfg_predicate, field("consequence", $._field_cfg_body))),
        optional(seq("else", field("alternate", $._field_cfg_body))),
      ),
    _field_cfg_body: ($) =>
      choice(
        $.field_declaration,
        seq("{", sepBy(",", $.field_declaration), optional(","), "}"),
      ),

    _struct_body: ($) =>
      seq(
        "{",
        sepBy(",", choice($.field_declaration, $.field_cfg_group)),
        optional(","),
        repeat(choice($._member, $.member_cfg_group)),
        "}",
      ),

    struct_expression: ($) =>
      seq(repeat(choice("extern", "packed")), "struct", $._struct_body),

    union_expression: ($) => seq(optional("extern"), "union", $._struct_body),

    enumerator: ($) => seq(field("name", $.identifier), optional(seq("=", field("value", $._expression)))),

    // `@cfg(pred) <one enumerator/_ or { ..., ... }> [else @cfg(...) ...]* [else ...]?`
    enumerator_cfg_group: ($) =>
      seq(
        $.cfg_predicate,
        field("consequence", $._enumerator_cfg_body),
        repeat(seq("else", $.cfg_predicate, field("consequence", $._enumerator_cfg_body))),
        optional(seq("else", field("alternate", $._enumerator_cfg_body))),
      ),
    _enumerator_cfg_body: ($) =>
      choice(
        $.enumerator,
        seq("{", sepBy(",", choice($.enumerator, "_")), optional(","), "}"),
      ),

    enum_expression: ($) =>
      seq(
        "enum",
        optional(seq(":", field("underlying", $._type))),
        "{",
        sepBy(",", choice($.enumerator, "_", $.enumerator_cfg_group)),
        optional(","),
        repeat(choice($._member, $.member_cfg_group)),
        "}",
      ),

    // -------------------------------------------------------------- interfaces

    // `const W := interface { ... }`: required methods, default methods, associated types,
    // and associated consts.
    interface_expression: ($) => seq("interface", "{", repeat($._interface_member), "}"),

    _interface_member: ($) =>
      choice($.interface_method, $.associated_type, $.associated_const),

    // Bodyless (`;`) is a required method; with a body it's a default method.
    // Bodyless is a required method; with a body it's a default method -- either way the member
    // ends with a mandatory `;`, same as any other decl-shaped interface member.
    interface_method: ($) =>
      seq(
        optional(field("attributes", $.attribute_list)),
        optional("pub"),
        "const",
        field("name", $.identifier),
        ":=",
        "fn",
        $._fn_header,
        optional(field("body", $.block)),
        ";",
      ),

    // `Name: type;` (required) or `Name: type = Default;` (defaulted)
    associated_type: ($) =>
      seq(field("name", $.identifier), ":", "type", optional(seq("=", field("default", $._type))), ";"),

    // `const N: T;` (required) or `const N: T = expr;` (defaulted)
    associated_const: ($) =>
      seq(
        "const",
        field("name", $.identifier),
        ":",
        field("type", $._type),
        optional(seq("=", field("value", $._expression))),
        ";",
      ),

    // -------------------------------------------------------------- inline assembly

    asm_expression: ($) =>
      seq("asm", optional(field("result_type", $._type)), "{", sepBy(",", $.asm_clause), optional(","), "}"),

    asm_clause: ($) =>
      choice(
        seq("template", ":", field("template", choice($.string_literal, $.multiline_string_literal))),
        seq("outputs", ":", field("outputs", $.asm_operand_list)),
        seq("inputs", ":", field("inputs", $.asm_operand_list)),
        seq(
          "clobbers",
          ":",
          "(",
          sepBy(",", field("clobber", $.string_literal)),
          optional(","),
          ")",
        ),
        seq("options", ":", "(", sepBy(",", field("option", $.asm_option)), optional(","), ")"),
      ),

    asm_operand_list: ($) => seq("(", sepBy(",", $.asm_operand), optional(","), ")"),

    // `"=r"(x)` binds the output/input to `x`; `"=r"(_)` discards it (no expression is bound).
    asm_operand: ($) =>
      seq(field("constraint", $.string_literal), "=", field("value", choice($._expression, "_"))),

    asm_option: (_) => choice("volatile", "noreturn", "intel", "att", "align_stack"),

    // -------------------------------------------------------------- control flow

    if_expression: ($) =>
      choice(
        prec.right(
          seq(
            "if",
            optional("comptime"),
            "(",
            field("condition", $._expression),
            ")",
            field("consequence", $._if_branch),
            optional(seq("else", field("alternate", $._if_branch))),
          ),
        ),
        // `if comptime a else b`: `a` under compile-time evaluation, `b` at runtime. A `(`
        // right after `comptime` always starts a condition instead.
        prec.right(
          prec.dynamic(
            -1,
            seq(
              "if",
              "comptime",
              field("consequence", $._if_branch),
              optional(seq("else", field("alternate", $._if_branch))),
            ),
          ),
        ),
      ),

    // A branch is a statement (`if (c) { ... }`, `if (c) return x;`) or, in value position, a
    // bare expression (`return if (c) a else b;`)
    // `else if` chains nest directly rather than through an expression statement
    _if_branch: ($) =>
      choice(
        prec.dynamic(1, $.if_expression),
        $._statement_body,
        prec.dynamic(-1, $._expression),
      ),

    // `return` / `break` / `continue` used as a value (a `match` arm body) take no `;`
    _jump_value: ($) =>
      choice(
        alias($._return_value, $.return_statement),
        alias($._break_value, $.break_statement),
        alias($._continue_value, $.continue_statement),
      ),
    _return_value: ($) => seq("return", optional($._value)),
    _break_value: ($) =>
      seq("break", optional(seq(":", field("label", $.identifier))), optional($._expression)),
    _continue_value: ($) => seq("continue", optional(seq(":", field("label", $.identifier)))),

    // Patterns are restricted (not full expressions) so `|capture|` never collides with the `|`
    // bitwise-or operator
    _pattern: ($) =>
      choice(
        $.identifier,
        $.integer_literal,
        $.float_literal,
        $.string_literal,
        $.char_literal,
        $.boolean_literal,
        $.underscore,
        $.dot_expression,
        $.implicit_access_expression,
        $.call_expression,
        $.index_expression,
        $.array_expression,
        $.function_expression,
        $.dereference_expression,
        $.reference_expression,
        $.address_of_expression,
        $.range_expression,
      ),

    match_arm: ($) =>
      seq(
        field("pattern", sepBy1(",", $._pattern)),
        // A trailing comma before `=>` keeps one pattern per line (`.a, .b, => x`)
        optional(","),
        "=>",
        optional(
          seq(
            "|",
            optional(choice("&", "^", seq("&", "mut"), seq("^", "mut"))),
            field("capture", choice($.identifier, "_")),
            "|",
          ),
        ),
        field("body", choice($._expression, $._jump_value)),
      ),

    match_expression: ($) =>
      seq(
        "match",
        optional("comptime"),
        "(",
        field("matcher", $._expression),
        ")",
        "{",
        sepBy(",", $.match_arm),
        optional(","),
        "}",
      ),

    capture: ($) =>
      seq(optional(choice("&", "^", seq("&", "mut"), seq("^", "mut"))), choice($.identifier, "_")),

    for_expression: ($) =>
      prec.right(
        seq(
          "for",
          optional("comptime"),
          "(",
          sepBy(",", $._expression),
          optional(","),
          ")",
          optional(seq("|", sepBy(",", $.capture), optional(","), "|")),
          field("body", $.block),
          optional(seq("else", field("alternate", $._statement_body))),
        ),
      ),

    while_expression: ($) =>
      prec.right(
        seq(
          "while",
          optional("comptime"),
          "(",
          field("condition", $._expression),
          ")",
          optional(seq(":", "(", $._expression, ")")),
          field("body", $.block),
          optional(seq("else", field("alternate", $._statement_body))),
        ),
      ),

    do_while_expression: ($) =>
      seq(
        "do",
        field("body", $.block),
        "while",
        optional("comptime"),
        "(",
        field("condition", $._expression),
        ")",
      ),

    loop_expression: ($) => seq("loop", optional("comptime"), field("body", $.block)),
  },
});

function sepBy(sep, rule) {
  return optional(seq(rule, repeat(seq(sep, rule))));
}

function sepBy1(sep, rule) {
  return seq(rule, repeat(seq(sep, rule)));
}

function sepByPlus(rule) {
  return seq(rule, repeat(seq("+", rule)));
}
