import 'reflect-metadata';
import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { MikroORM, ref, MetadataProvider } from '@mikro-orm/sqlite';

// ---------------------------------------------------------------------------
// TPT hierarchy: Animal (abstract) -> Dog (concrete)
// ---------------------------------------------------------------------------

@Entity({ inheritance: 'tpt' })
abstract class Animal {

  @PrimaryKey({ type: 'integer' })
  id!: number;

  @Property({ type: 'string' })
  name!: string;

}

@Entity()
class Dog extends Animal {

  @Property({ type: 'string' })
  breed!: string;

}

// ---------------------------------------------------------------------------
// Simple entities used in the polymorphic union
// ---------------------------------------------------------------------------

@Entity()
class Person {

  @PrimaryKey({ type: 'integer' })
  id!: number;

  @Property({ type: 'string' })
  name!: string;

}

@Entity()
class Shelter {

  @PrimaryKey({ type: 'integer' })
  id!: number;

  @Property({ type: 'string' })
  location!: string;

}

// ---------------------------------------------------------------------------
// Entity with a polymorphic manyToOne that includes the abstract TPT root
// ---------------------------------------------------------------------------

@Entity()
class Activity {

  @PrimaryKey({ type: 'integer' })
  id!: number;

  @Property({ type: 'string' })
  description!: string;

  // Polymorphic relation — subject can be an Animal, Person, or Shelter.
  // The problem: Animal is an abstract TPT entity whose only concrete
  // subclass is Dog. MikroORM cannot reconcile TPT inheritance with the
  // polymorphic discriminator mechanism.
  @ManyToOne(() => [Animal, Person, Shelter], { nullable: true })
  subject?: Animal | Person | Shelter | null;

}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init({
    dbName: ':memory:',
    entities: [Animal, Dog, Person, Shelter, Activity],
    metadataProvider: MetadataProvider,
    debug: ['query', 'query-params'],
    allowGlobalContext: true,
  });
  await orm.schema.refresh();
});

afterAll(async () => {
  await orm.close(true);
});

// ---------------------------------------------------------------------------
// Test 1 — INSERT: polymorphic ref to a TPT child instance
//
// When we create a Dog (concrete subclass of abstract TPT Animal) and assign
// it as the `subject` of an Activity, MikroORM tries to resolve the
// polymorphic discriminator from the concrete class Dog. But Dog is not in
// the polymorphic union [Animal, Person, Shelter], so the discriminator
// resolves to undefined and the INSERT fails.
// ---------------------------------------------------------------------------

test('INSERT: assigning a TPT child entity as a polymorphic relation value', async () => {
  const dog = orm.em.create(Dog, { name: 'Rex', breed: 'German Shepherd' });
  await orm.em.flush();

  orm.em.create(Activity, {
    description: 'Adopted a dog',
    // @ts-expect-error BUG: Dog extends Animal, and Animal is in the polymorphic
    // union [Animal, Person, Shelter], so ref(dog) should be assignable here.
    // But MikroORM's generated types for the polymorphic property don't account
    // for TPT subclasses — Reference<Dog> is not assignable to the union type.
    subject: ref(dog),
  });

  // This flush succeeds, but the INSERT sets subject_type to NULL instead of
  // a valid discriminator value. MikroORM resolves the discriminator from the
  // concrete class Dog, which is not in the polymorphic union
  // [Animal, Person, Shelter], so it cannot map the type and silently writes
  // NULL. The data is now corrupted — the FK id is stored but the type is lost.
  await orm.em.flush();
  orm.em.clear();

  const activity = await orm.em.findOneOrFail(Activity, { description: 'Adopted a dog' });

  // BUG: subject is undefined because subject_type was stored as NULL,
  // making MikroORM unable to hydrate the polymorphic reference back.
  // Expected: subject should be a reference to the Dog (as an Animal).
  expect(activity.subject).toBeDefined();
});

// ---------------------------------------------------------------------------
// Test 2 — SELECT: populating a polymorphic relation that targets an abstract
// TPT entity
//
// When querying Activity with populate: ['subject'], MikroORM generates LEFT
// JOINs for each entity in the polymorphic union. For Animal (abstract TPT),
// MikroORM only joins the parent `animal` table and never joins the child
// `dog` table. This means:
//   - The entity is hydrated as a bare Animal, not the concrete Dog subclass
//   - TPT child properties (e.g. `breed`) are missing entirely
//   - The polymorphic relation doesn't account for the TPT parent+child
//     table split
// ---------------------------------------------------------------------------

test('SELECT: populating a polymorphic relation that includes an abstract TPT entity', async () => {
  // Seed data directly via raw SQL so we don't depend on Test 1's broken
  // INSERT discriminator. We manually set subject_type = 'animal' to
  // simulate a correctly-stored polymorphic ref to a TPT entity.
  orm.em.clear();

  const conn = orm.em.getConnection();
  await conn.execute(`insert into \`animal\` (\`name\`) values ('Buddy')`);
  const [{ id: animalId }] = await conn.execute(`select last_insert_rowid() as id`);
  await conn.execute(`insert into \`dog\` (\`id\`, \`breed\`) values (${animalId}, 'Labrador')`);
  await conn.execute(
    `insert into \`activity\` (\`description\`, \`subject_type\`, \`subject_id\`) values ('Walk the dog', 'animal', ${animalId})`,
  );

  // When populating the polymorphic relation, MikroORM only LEFT JOINs the
  // `animal` parent table — it does NOT join the `dog` child table. This
  // means the populated entity is missing the TPT child data (e.g. `breed`).
  // The entity is hydrated as a bare Animal, not as a Dog, so TPT
  // inheritance is effectively broken for polymorphic relations on SELECT.
  const activities = await orm.em.find(
    Activity,
    {},
    { populate: ['subject'] },
  );

  expect(activities.length).toBeGreaterThan(0);
  const walkActivity = activities.find(a => a.description === 'Walk the dog');
  expect(walkActivity).toBeDefined();
  expect(walkActivity!.subject).toBeDefined();

  // BUG: The subject should be hydrated as a Dog (the concrete TPT subclass),
  // but MikroORM only joins the parent `animal` table and doesn't resolve the
  // concrete subtype. The entity is missing TPT child properties like `breed`.
  expect(walkActivity!.subject).toBeInstanceOf(Dog);
  expect((walkActivity!.subject as Dog).breed).toBe('Labrador');
});
