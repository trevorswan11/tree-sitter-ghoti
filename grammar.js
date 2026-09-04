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

  extras: ($) => [/\s/, $.comment],

  word: ($) => $.identifier,

  conflicts: ($) => [
    [$._type, $._expression],
    [$.extern_modifier, $.struct_expression],
    [$._type, $.array_expression],
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
    [$.dyn_type],
  ],

  rules: {
    source_file: ($) => repeat($._statement),

    comment: (_) => token(seq("//", /[^\n]*/)),

    // ---------------------------------------------------------------- statements

    _statement: ($) =>
      choice(
        $.decl_statement,
        $.import_statement,
        $.using_statement,
        $.defer_statement,
        $.break_statement,
        $.continue_statement,
        $.return_statement,
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
      choice("pub", $.extern_modifier, $.export_modifier, "threadlocal", "weak"),

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
        repeat($._decl_modifier),
        field("kind", choice("var", "const", "constexpr")),
        field("name", $.identifier),
        optional(seq(":", field("type", $._type))),
        optional(seq(choice(":=", "="), field("value", $._expression))),
        ";",
      ),

    import_statement: ($) =>
      seq(
        repeat($._decl_modifier),
        "import",
        field("path", choice($.string_literal, $.identifier)),
        optional(seq("as", field("alias", $.identifier))),
        ";",
      ),

    using_statement: ($) =>
      seq(
        repeat($._decl_modifier),
        "using",
        field("alias", $.identifier),
        "=",
        field("type", $._type),
        ";",
      ),

    defer_statement: ($) => seq("defer", field("body", $._statement_body)),
    break_statement: ($) =>
      seq("break", optional(seq(":", field("label", $.identifier))), optional($._expression), ";"),
    continue_statement: ($) =>
      seq("continue", optional(seq(":", field("label", $.identifier))), ";"),
    return_statement: ($) => seq("return", optional($._expression), ";"),

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
      seq(optional("constexpr"), field("name", $.identifier), ":", field("type", $._type)),

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
        $.impl_type,
        $.primitive_type,
        $.identifier,
        $.module_access_expression,
        $.call_expression, // e.g. std::ArrayList(u8)
        $.struct_expression,
        $.union_expression,
        $.enum_expression,
        $.interface_expression,
        $.builtin_call_expression, // e.g. @this()
        $.modified_type, // bare `mut`/`volatile` prefix, e.g. `var v: mut volatile i32;`
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

    // `dyn I` / `dyn I(Assoc = T, ...)`; wrapped as `&dyn I` / `^dyn I` via reference/pointer
    // types since `dyn` sits where a type normally would.
    dyn_type: ($) =>
      seq(
        "dyn",
        field("interface", $.identifier),
        repeat(seq("::", field("interface", $.identifier))),
        optional($.dyn_assoc_bindings),
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
    // types; the return type is mandatory.
    function_type: ($) =>
      seq(
        "fn",
        "(",
        sepBy(",", choice($.parameter, "...")),
        optional(","),
        ")",
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
        "constexpr_int",
        "constexpr_float",
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
        $.char_literal,
        $.boolean_literal,
        $.undefined_literal,
        $.unreachable_literal,
        $.nullptr_literal,
        $.underscore,
        $.builtin_call_expression,
        $.call_expression,
        $.index_expression,
        $.dot_expression,
        $.implicit_access_expression,
        $.module_access_expression,
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
        $.block,
        $.parenthesized_expression,
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
    // `f`-suffixed integer (no `.`) is also a float, as is an exponent with no `.`.
    float_literal: (_) =>
      token(
        choice(
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

    string_literal: (_) => token(seq('"', repeat(choice(/[^"\\]/, /\\./)), '"')),

    char_literal: (_) => token(seq("'", choice(/[^'\\]/, /\\./), "'")),

    identifier: (_) => /[A-Za-z_][A-Za-z0-9_]*/,

    builtin_call_expression: ($) =>
      seq(field("function", alias(/@[A-Za-z_][A-Za-z0-9_]*/, $.builtin_identifier)), $.arguments),

    arguments: ($) => seq("(", sepBy(",", choice($._expression, $._type)), optional(","), ")"),

    call_expression: ($) =>
      prec(PREC.CALL, seq(field("function", $._expression), field("arguments", $.arguments))),

    index_expression: ($) =>
      prec(PREC.CALL, seq(field("array", $._expression), "[", field("index", $._expression), "]")),

    dot_expression: ($) =>
      prec(PREC.FIELD, seq(field("object", $._expression), ".", field("member", $.identifier))),

    implicit_access_expression: ($) => prec(PREC.FIELD, seq(".", field("member", $.identifier))),

    module_access_expression: ($) =>
      prec.left(
        PREC.FIELD,
        seq(field("module", $._expression), "::", field("member", $.identifier)),
      ),

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
      prec(PREC.FIELD + 1, seq(".", field("name", $.identifier), "=", field("value", $._expression))),

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
        [PREC.SHIFT, choice("<<", ">>")],
        [PREC.ADD, choice("+", "-")],
        [PREC.MUL, choice("*", "/", "%")],
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
            choice("=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", "~="),
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

    parameter: ($) =>
      seq(field("name", $.identifier), ":", field("type", $._type)),

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
        seq(optional(choice("move", "naked")), "fn", $._fn_header, field("body", $.block)),
        prec.dynamic(-1, seq(optional(choice("move", "naked")), "fn", $._fn_header)),
      ),

    // -------------------------------------------------------------- struct/union/enum

    _member: ($) => choice($.decl_statement, $.import_statement, $.using_statement),

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
        seq("template", ":", field("template", $.string_literal)),
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

    asm_operand: ($) =>
      seq(field("constraint", $.string_literal), "=", field("value", $._expression)),

    asm_option: (_) => choice("volatile", "noreturn", "intel", "att", "align_stack"),

    // -------------------------------------------------------------- control flow

    if_expression: ($) =>
      prec.right(
        seq(
          "if",
          optional("constexpr"),
          "(",
          field("condition", $._expression),
          ")",
          field("consequence", $._statement_body),
          optional(seq("else", field("alternate", $._statement_body))),
        ),
      ),

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
        $.module_access_expression,
        $.call_expression,
        $.index_expression,
        $.dereference_expression,
        $.reference_expression,
        $.address_of_expression,
        $.range_expression,
      ),

    match_arm: ($) =>
      seq(
        field("pattern", sepBy1(",", $._pattern)),
        "=>",
        optional(
          seq(
            "|",
            optional(choice("&", "^", seq("&", "mut"), seq("^", "mut"))),
            field("capture", choice($.identifier, "_")),
            "|",
          ),
        ),
        field("body", $._expression),
      ),

    match_expression: ($) =>
      seq(
        "match",
        optional("constexpr"),
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
          "(",
          field("condition", $._expression),
          ")",
          optional(seq(":", "(", $._expression, ")")),
          field("body", $.block),
          optional(seq("else", field("alternate", $._statement_body))),
        ),
      ),

    do_while_expression: ($) =>
      seq("do", field("body", $.block), "while", "(", field("condition", $._expression), ")"),

    loop_expression: ($) => seq("loop", field("body", $.block)),
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
