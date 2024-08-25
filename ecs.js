class ECS {
    constructor() {
        this.entities = {};
        this.systems = {};
        this.components = {};
        this.queries = {};
        this.events = new ECSEvent();
    }

    registerSystem(system_class) {
        const system = new system_class(this);
        const system_name = system.constructor.name;
        if (system_name in this.systems) {
            console.error(`System ${system_name} already registered with ECS`);
        }
        else {
            system.ecs = this; // add reference to ECS for queries
            this.systems[system_name] = system;
            system.onRegistration();
        }
    }

    addEntity(entity) {
        this.entities[entity.id] = entity;
    }

    registerComponent (component_class) { 
        if (component_class.name in this.components) {
            console.error(`Component ${component_class.name} already registered with ECS`);
        }
        else {
            component_class.ecs = this; // add reference to ECS for queries
            this.components[component_class.name] = component_class;
            this.components[component_class.name].entities = {}; // list of entities with this component for queries
        }
    }

    update(delta) {
        // update systems
        Object.entries(this.systems).forEach(([key, value]) => {
            //console.log('Updating system:', key);
            this.systems[key].update(delta);
        });
    }

    createQuery(logic) {
        if (logic in this.queries) {
            console.error(`Query ${logic} already exists in ECS`);
            return false;
        }
        else {
            this.queries[logic] = new Query(this, logic);
            this.queries[logic].refresh(); // run query for the first time - for dynamic queries/systems this ensures we have the correct entities
            return true;
        }
    }

    query(logic) {
        if (logic in this.queries) {
            // effectively a cache - query entities are updated when components are added or removed
            // in component_added event listener in Query class
            return this.queries[logic].entities;
        }
        else {
            if (this.createQuery(logic)) {
                return this.queries[logic].entities;
            }
            else {
                console.error(`Query ${logic} not found in ECS - creation failed`);
                return {};
            }
        }
    }
}

class ECSEvent extends EventTarget {}

class Entity {
    constructor(ecs) {
        this.id = crypto.randomUUID();
        this.components = {};
        this.ecs = ecs;
        this.ecs.addEntity(this);
    }

    addComponent(component_class, properties) {
        //const class_name = component_class.name;
        const component = new component_class(properties);
        if (!(component.constructor.name in this.ecs.components)) {
            throw new Error(`Component ${component} not registered with ECS`);
        }
        else {
            // add to components object and entity root with component name as key for easy access
            this[component.constructor.name] = component;
            this.components[component.constructor.name] = component;
            // add entity id to ECS component object for queries
            // e.g. let entities_with_position = ECS.components.Position.entities;
            this.ecs.components[component.constructor.name].entities[this.id] = true; // value is not important
            component.onAttached(this);
            this.ecs.events.dispatchEvent(new CustomEvent('component_added', {detail: {entity: this, component: component}}));
        }
    }

    removeComponent(component_class) {
        if (component_class.name in this) {
            const component_name = component_class.name;
            delete this[component_name]; // remove from self
            delete this.components[component_name]; // remove from components object in self
            delete this.ecs.components[component_name].entities[this.id]; // delete this entity from component entities list
            // refresh queries that use this component
            for (const query_name in this.ecs.queries) {
                let query = this.ecs.queries[query_name];
                if (query.component_names.includes(component_name)) {
                    query.refresh();
                }
            }
        }
        else {
            console.error(`Component ${component_name} not found in entity`);
        }
    }
}

class Component {
    constructor(properties = {}) {
        Object.assign(this, properties);
    }
    onAttached(entity) {
        this.entity = entity;
    }
    onDestroyed() {}
    onEvent(evt) {}
}   

class System {
    constructor(ecs) {
        this.ecs = ecs;
    }
    update(delta) {}
    onRegistration() {}
}

class Query {
    constructor(ecs, logic) {
        // ecs is the ECS instance (for multiple worlds) - usually provided by system
        // logic is an array of component class names (strings, not actual classes)
        // FOR NOW, just doing AND 1st level
        // TODO: implement OR logic, and NOT logic (e.g. !Component)
        // outer array is OR, inner array is AND

        // determine component classes from logic
        let components = [];
        let component_names = [];
        for (let i = 0; i < logic.length; i++) {
            let component_name = logic[i];
            // check if logic[i] starts with symbol for NOT
            if (component_name.startsWith('!')) {
                // remove symbol
                component_name = component_name.slice(1);
            }
            components.push(ecs.components[component_name]);
            component_names.push(component_name);
        }
        this.components = components;
        this.component_names = component_names;
        this.logic = logic;
        this.entities = {}; 
        this.ecs = ecs;
        let self = this;
        this.ecs.events.addEventListener('component_added', function(ev) {
            // component added to entity, check if it matches query
            // if it does, add entity to our entities cache object for this query
            self.componentAddedToEntity(ev.detail.entity);
        });
        this.refresh(); // run query for the first time - for dynamic queries/systems this ensures we have the correct entities
        //console.log('Query generated:', this);
    }
    componentAddedToEntity(entity) {
        // check if entity matches query
        // if it does, add entity to our entities object for this query
        // loop over entity components for a match in our query
        // TODO: implement OR logic, and NOT logic (e.g. !Component)
        let num_matches_required = this.components.length; // only works for current AND ONLY logic
        let cur_match_count = 0;
        for (const property in entity.components) {
            if (this.component_names.includes(property)) {
                cur_match_count++;
            }
        }
        if (cur_match_count == num_matches_required) {
            this.entities[entity.id] = entity;
        }
    }
    refresh() {
        // clear entities and re-run query for accuracy
        // this is useful for when components are added or removed
        // not performant for every frame, but useful for debugging
        // TODO: implement OR logic, and NOT logic (e.g. !Component)
        this.entities = {};
        let num_matches_required = this.components.length; // only works for current AND ONLY logic
        // slow - start with all ecs entities as potential matches
        // could use longest component list to start with, but won't work for more complex logic
        for (let entity_id in this.ecs.entities) {
            // loop over all components in our query
            let cur_match_count = 0;
            for (let i = 0; i < this.components.length; i++) {
                let component = this.components[i];
                if (component.entities[entity_id]) {
                    cur_match_count++;
                }
            }
            if (cur_match_count == num_matches_required) {
                this.entities[entity_id] = true; // value is not important
            }
        }
    }
}

export { ECS, Entity, Component, System, Query, ECSEvent };


