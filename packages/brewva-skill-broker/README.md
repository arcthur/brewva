# Brewva Skill Broker

This package currently hosts the skill-promotion draft pipeline for Brewva.

Current responsibilities:

- derive repeat-backed promotion drafts from completed work
- persist promotion draft state under `.brewva/skill-broker/`
- inject pending promotion drafts into hosted context when the prompt asks to
  promote or codify learning
- review and materialize promotion packets through the `skill_promotion` tool

Non-responsibilities:

- runtime skill discovery
- skill routing
- skill activation

Those runtime lifecycle concerns live in `@brewva/brewva-runtime`.
