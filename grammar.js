// Tree-sitter grammar for the ghoti programming language (https://github.com/trevorswan11/ghoti)
//
// Grounded directly in the compiler's own lexer/parser/AST:
//   lib/compiler/include/compiler/syntax/keywords.hh
//   lib/compiler/include/compiler/syntax/operators.hh
//   lib/compiler/include/compiler/syntax/builtins.hh
//   lib/compiler/include/compiler/ast/statement.hh
//   lib/compiler/include/compiler/ast/expression.hh
// This is a highlighting-grade grammar: precedence/nesting is close to the real compiler's, but
// need not be perfectly semantically faithful -- only good enough to tokenize and structure real
// ghoti source correctly for editor highlighting/indentation, not to re-implement the compiler.

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
    [$._decl_modifier, $.struct_expression],
    [$._type, $.array_expression],
    [$.labeled_statement, $._expression],
    [$.function_type, $.function_expression],
    [$.modified_type, $.pointer_type],
    [$.modified_type, $.reference_type],
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
        $.labeled_statement,
        $.expression_statement,
      ),

    block: ($) => seq("{", repeat($._statement), "}"),

    labeled_statement: ($) =>
      seq(field("label", $.identifier), ":", choice($.block, $._expression), ";"),

    _decl_modifier: (_) => choice("pub", "extern", "export"),

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

    _statement_body: ($) => $._statement,

    // NOTE: the real compiler tolerates omitting this trailing `;` when the statement's last
    // branch already self-terminates (a nested `return b;`, or a bare `}` block) -- e.g.
    // `while (true) {a;} else return b;` needs no second `;`. Modeling that precisely introduced
    // more structural ambiguity than it was worth for a highlighting-grade grammar; tree-sitter's
    // own error recovery synthesizes a MISSING `;` in that case, which still produces a fully
    // correct, complete tree (unlike an ERROR node) -- a documented, benign imperfection, not a
    // parse failure.
    expression_statement: ($) => seq($._expression, ";"),

    // ---------------------------------------------------------------- types

    _type: ($) =>
      choice(
        $.pointer_type,
        $.reference_type,
        $.array_type, // also covers slice types `[]T` (empty size)
        $.function_type,
        $.primitive_type,
        $.identifier,
        $.module_access_expression,
        $.call_expression, // e.g. std::ArrayList(u8)
        $.struct_expression,
        $.union_expression,
        $.enum_expression,
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

    function_type: ($) =>
      seq(
        "fn",
        "(",
        sepBy(",", choice($._type, "...")),
        optional(","),
        ")",
        optional(seq(":", field("return_type", $._type))),
      ),

    primitive_type: (_) =>
      choice(
        "i32",
        "i64",
        "isize",
        "u32",
        "u64",
        "usize",
        "f32",
        "f64",
        "u8",
        "bool",
        "void",
        "type",
        "auto",
        "opaque",
        "noreturn",
      ),

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
        $.function_expression,
        $.struct_expression,
        $.union_expression,
        $.enum_expression,
        $.if_expression,
        $.match_expression,
        $.for_expression,
        $.while_expression,
        $.do_while_expression,
        $.loop_expression,
        $.block,
        $.parenthesized_expression,
      ),

    parenthesized_expression: ($) => seq("(", $._expression, ")"),

    underscore: (_) => "_",
    boolean_literal: (_) => choice("true", "false"),
    undefined_literal: (_) => "undefined",
    unreachable_literal: (_) => "unreachable",
    nullptr_literal: (_) => "nullptr",

    integer_literal: (_) =>
      token(
        choice(
          /0[xX][0-9a-fA-F_]+[uU]?[zZlL]?/,
          /0[bB][01_]+[uU]?[zZlL]?/,
          /0[oO][0-7_]+[uU]?[zZlL]?/,
          /[0-9][0-9_]*[uU]?[zZlL]?/,
        ),
      ),

    float_literal: (_) => token(seq(/[0-9][0-9_]*/, ".", /[0-9][0-9_]*/, optional(/[fF]/))),

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
        seq(".", "{", sepBy(",", $.field_initializer), optional(","), "}"),
        seq(field("type", $._expression), "{", sepBy(",", $.field_initializer), optional(","), "}"),
      ),

    field_initializer: ($) =>
      seq(".", field("name", $.identifier), "=", field("value", $._expression)),

    array_expression: ($) =>
      seq(field("array_type", $.array_type), "{", sepBy(",", $._expression), optional(","), "}"),

    unary_expression: ($) =>
      prec(PREC.UNARY, seq(field("operator", choice("!", "~", "-", "+")), field("operand", $._expression))),

    dereference_expression: ($) => prec(PREC.UNARY, seq("*", field("operand", $._expression))),
    reference_expression: ($) =>
      prec(PREC.UNARY, seq("&", optional("mut"), field("operand", $._expression))),
    address_of_expression: ($) =>
      prec(PREC.UNARY, seq("^", optional("mut"), field("operand", $._expression))),

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

    range_expression: ($) =>
      prec.left(
        PREC.RANGE,
        seq(field("start", $._expression), choice("..", "..="), field("end", $._expression)),
      ),

    // -------------------------------------------------------------- functions

    self_parameter: ($) =>
      seq(optional(choice("&", "^", seq("&", "mut"), seq("^", "mut"))), choice("self", "this")),

    parameter: ($) =>
      seq(field("name", $.identifier), ":", field("type", $._type)),

    function_expression: ($) =>
      seq(
        optional("move"),
        "fn",
        "(",
        optional(seq($.self_parameter, optional(","))),
        sepBy(",", $.parameter),
        optional(seq(optional(","), "...")),
        optional(","),
        ")",
        optional(seq(":", field("return_type", $._type))),
        field("body", $.block),
      ),

    // -------------------------------------------------------------- struct/union/enum

    _member: ($) => choice($.decl_statement, $.import_statement, $.using_statement),

    field_declaration: ($) =>
      seq(
        optional("pub"),
        field("name", $.identifier),
        ":",
        field("type", $._type),
        optional(seq("=", field("default", $._expression))),
      ),

    _struct_body: ($) => seq("{", sepBy(",", $.field_declaration), optional(","), repeat($._member), "}"),

    struct_expression: ($) =>
      seq(repeat(choice("extern", "packed")), "struct", $._struct_body),

    union_expression: ($) => seq(optional("extern"), "union", $._struct_body),

    enumerator: ($) => seq(field("name", $.identifier), optional(seq("=", field("value", $._expression)))),

    enum_expression: ($) =>
      seq(
        "enum",
        optional(seq(":", field("underlying", $._type))),
        "{",
        sepBy(",", choice($.enumerator, "_")),
        optional(","),
        repeat($._member),
        "}",
      ),

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
      ),

    match_arm: ($) =>
      seq(
        field("pattern", $._pattern),
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
      seq("match", "(", field("matcher", $._expression), ")", "{", sepBy(",", $.match_arm), optional(","), "}"),

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
