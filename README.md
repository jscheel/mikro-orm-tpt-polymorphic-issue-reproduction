# MikroORM reproduction: TPT inheritance + polymorphic relations

This reproduction demonstrates an incompatibility between **Table-Per-Type (TPT) inheritance** and **polymorphic `manyToOne` relations** in MikroORM 7.

## Setup

```
Animal (abstract, TPT root)    Person    Shelter
  └── Dog (concrete)              │         │
                                  └────┬────┘
                                       │
                              Activity.subject
                         (polymorphic manyToOne)
                    @ManyToOne(() => [Animal, Person, Shelter])
```

`Activity.subject` is a polymorphic relation that can point to an `Animal`, `Person`, or `Shelter`. `Animal` uses TPT inheritance — it is abstract with a concrete `Dog` subclass. Each has its own table (`animal` and `dog`).

## Bug 1 — INSERT: polymorphic discriminator is `null` for TPT child entities

When a `Dog` instance (concrete TPT subclass of `Animal`) is assigned as the polymorphic `subject` of an `Activity`, MikroORM resolves the discriminator from the concrete class `Dog`. Since `Dog` is not listed in the polymorphic union `[Animal, Person, Shelter]`, the discriminator cannot be mapped and `subject_type` is silently written as `null`.

**Generated SQL:**

```sql
insert into `activity` (`description`, `subject_type`, `subject_id`)
values ('Adopted a dog', null, 1)
```

**Expected:** `subject_type` should be `'animal'` (the TPT root table name), since `Dog` IS-A `Animal` and `Animal` is in the union.

**Result:** `subject_type` is `null`. The FK id is stored but the type is lost, so the polymorphic reference can never be hydrated back. On re-read, `activity.subject` is `undefined`.

## Bug 2 — SELECT: polymorphic populate does not resolve TPT child entities

When populating the polymorphic `subject` relation, MikroORM only LEFT JOINs the parent `animal` table for the `Animal` entry in the union. It does not join the `dog` child table. This means:

- The entity is hydrated as a bare `Animal`, not the concrete `Dog` subclass
- TPT child properties (e.g. `breed`) are missing entirely

**Generated SQL:**

```sql
select `a0`.*,
       `a1`.`id` as `a1__id`, `a1`.`name` as `a1__name`,
       `p2`.`id` as `p2__id`, `p2`.`name` as `p2__name`,
       `s3`.`id` as `s3__id`, `s3`.`location` as `s3__location`
from `activity` as `a0`
  left join `animal` as `a1` on `a0`.`subject_id` = `a1`.`id` and `a0`.`subject_type` = 'animal'
  left join `person` as `p2` on `a0`.`subject_id` = `p2`.`id` and `a0`.`subject_type` = 'person'
  left join `shelter` as `s3` on `a0`.`subject_id` = `s3`.`id` and `a0`.`subject_type` = 'shelter'
```

**Expected:** The query should also join `dog` (and any other TPT children) to fully hydrate the concrete subclass with all its properties.

**Result:** No `dog` table join. The populated entity is an `Animal` instance missing `breed`, not a `Dog`.

## Bug 3 — TypeScript: `ref(dog)` is not assignable to the polymorphic union type

`Dog extends Animal`, and `Animal` is in the polymorphic union `[Animal, Person, Shelter]`. Logically, `ref(dog)` should be assignable to `Activity.subject`. But MikroORM's generated types for the polymorphic property don't account for TPT subclasses, so TypeScript rejects the assignment:

```
error TS2322: Type 'Reference<Dog>' is not assignable to type
  'Animal | Person | Shelter | RequiredEntityData<Animal, Activity, false> | ...'
```

This means there is no type-safe way to assign a TPT child entity to a polymorphic relation that references its parent. The test uses `@ts-expect-error` to document this.

**Expected:** `Reference<Dog>` should be assignable since `Dog extends Animal` and `Animal` is in the union.

**Result:** Type error. Users must cast (`ref(dog as Animal)` or `as any`) to work around it.

## Root cause

Polymorphic relations were designed for flat entities (one entity = one table). TPT breaks this assumption at three levels:

1. **Discriminator mapping** — `ref(dog)` resolves the discriminator from the concrete class `Dog`, but only the abstract parent `Animal` is in the polymorphic union. MikroORM doesn't walk the TPT hierarchy to find the matching union member.
2. **JOIN generation** — The polymorphic populate creates one LEFT JOIN per union member. For TPT entities this only joins the root table, not the child tables needed to hydrate the concrete subclass.
3. **Type generation** — The polymorphic property type only accepts the exact entities listed in the union, not their TPT subclasses.

## Running

```bash
pnpm install
pnpm test        # both tests fail
pnpm typecheck   # passes only because @ts-expect-error documents the type bug
```

All three bugs are demonstrated in `src/example.test.ts`.
