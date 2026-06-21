; Import declarations
(import_statement) @import.statement

; Function declarations
(function_declaration
  name: (identifier) @function.name)

; Calls such as console.log(...) and greet(...)
(call_expression
  function: [
    (identifier) @call.name
    (member_expression
      property: (property_identifier) @call.name)
  ])
