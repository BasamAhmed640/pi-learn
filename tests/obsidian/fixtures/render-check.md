---
title: Render check
tags:
  - pi-learn
  - fixture
lesson: 0
created: 2026-09-23
cssclasses:
  - pi-learn
---

# Render check

This fixture exercises everything pi-learn writes into Obsidian. The verifier
must report **4 rendered diagrams, 1 Mermaid error and 1 unresolved link**.

%% hidden comment: this must not appear in reading view %%

## Some heading

Jump back here with [[#Some heading]]. This link is broken on purpose: [[Missing note]].

## Valid diagrams

```mermaid
flowchart TD
    subgraph Loop["Learning loop"]
        A[Read lesson] --> B{Quiz}
        B -->|correct| C[Next concept]
        B -->|wrong| D[Review]
    end
    D -->|feedback| A
    C --> E((Done))
```

```mermaid
sequenceDiagram
    participant U as You
    participant P as Pi
    U->>P: Ask a question
    P-->>U: Explain the idea
    U->>P: Answer the quiz
    P-->>U: Feedback
```

```mermaid
stateDiagram-v2
    [*] --> Learning
    Learning --> Quizzed: finish lesson
    Quizzed --> Mastered: pass
    Quizzed --> Learning: fail
    Mastered --> [*]
```

## Broken diagram

```mermaid
flowchart TD
    A[Foo (bar)] --> B
```

## Callouts

> [!quote] YOU
> Why does the square grow faster than the number?

> [!abstract] PI
> Squaring multiplies a number by itself, so the growth compounds.

> [!question] Quiz
> What is $x^2$ when $x = 3$?
>
> 1. 6
> 2. 9
> 3. 12
>
> ```mermaid
> flowchart LR
>     Q[x = 3] --> S[x squared]
>     S --> R[9]
> ```

> [!success] Correct
> $3^2 = 9$, because squaring means
>
> $$
> x^2 = x \cdot x
> $$

> [!failure] Not quite
> $3 \times 2 = 6$ is doubling, not squaring.

> [!warning] Watch out
> Do not confuse $2x$ with $x^2$.

Display math:

$$
\sum_{k=1}^{n} k = \frac{n(n+1)}{2}
$$
