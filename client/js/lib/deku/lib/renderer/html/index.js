
/**
 * Dependencies.
 */

var Interactions = require('./interactions');
var Entity = require('../../entity');
var each = require('component-each');
var patch = require('./diff');

/**
 * Export.
 */

module.exports = HTMLRenderer;

/**
 * Handles the rendering of a scene graph by running
 * diffs on the current virtual tree of the entities with
 * the previous version. It then applies this diff to the
 * acutal DOM tree.
 *
 * Instead of using SceneNodes or some other object type, we're
 * just using the entities themselves, since each SceneNode can only
 * have a single entity anyway. In the future we could split these up, but
 * it seems simpler to do it this way for now.
 */

function HTMLRenderer(container) {
  this.container = container;
  this.events = new Interactions(document.body);
  this.entities = {};
  this.elements = {};
  this.renders = {};
  this.children = {};
  this.rendered = null;
  this.dirty = [];
}

/**
 * Render an entity tree. This should be called on the top
 * level entity that is mounted to the container.
 *
 * @param {Entity} entity
 *
 * @api public
 */

HTMLRenderer.prototype.render = function(entity) {

  // The entity we're trying to render is already rendered
  // into the container, so let's just update it.
  if (this.rendered === entity) {
    if (this.dirty.length > 0) {
      this.update(entity);
    }
    return;
  }

  // Otherwise we're rendering a new entity onto the scene
  this.clear();
  this.mountEntity(entity, this.container);
  this.rendered = entity;
};

/**
 * Update an entity already on the scene.
 *
 * @param {Entity} entity
 *
 * @api private
 * @return {void}
 */

HTMLRenderer.prototype.update = function(entity) {
  var self = this;
  var nextProps = entity._pendingProps;
  var nextState = entity._pendingState;
  var previousState = entity.state;
  var previousProps = entity.props;
  var currentTree = this.renders[entity.id];
  var currentEl = this.elements[entity.id];

  // Recursive update
  function next(){
    self.updateChildren(entity);
  }

  // If the component never called setState or setProps
  // it won't need updating at all. This allows us to
  // skip further complex checks.
  if (!this.hasChanged(entity)) {
    return next();
  }

  // If setState or setProps have been called we can
  // allow a user-defined check to see if we should update the
  // component. This returns true by default. This allows the user
  // improve the overall performance of their app and avoids hard
  // to track down bugs. We essentially are trading a bit of
  // performance here for user-experience.
  if (!entity.shouldUpdate(nextProps, nextState)) {
    return next();
  }

  // pre-update. This callback could mutate the
  // state or props just before the render occurs
  entity.beforeUpdate(nextProps, nextState);

  // Now we can commit the state of the entity. All of the
  // pending props and state will now be committed and reflect
  // the actual state of the component.
  entity.commit();

  // Re-render the tree to get an up-to-date representation
  // of the component with the new props/state
  var nextTree = entity.render();

  // Run the diff and patch the element.
  var updatedEl = patch({
    entity: entity,
    currentTree: currentTree,
    nextTree: nextTree,
    el: currentEl,
    renderer: this
  });

  // Update the element for this component in case
  // the root node has changed.
  this.elements[entity.id] = updatedEl;
  this.renders[entity.id] = nextTree;
  this.updateEvents(entity);
  this.resolveEntity(entity);
  next();
  entity.afterUpdate(previousState, previousProps);
};

/**
 * Check to see if an entity has changed since the last rendering.
 *
 * @param {Entity} entity
 *
 * @return {Boolean}
 */

HTMLRenderer.prototype.hasChanged = function(entity) {
  return this.dirty.indexOf(entity.id) > -1;
};

/**
 * Resolve an entity's dirty state.
 *
 * @param {Entity} entity
 *
 * @return {Boolean}
 */

HTMLRenderer.prototype.resolveEntity = function(entity) {
  this.dirty = this.dirty.filter(function(id){
    return id !== entity.id;
  });
};

/**
 * Update all the children of an entity
 *
 * @param {Entity} entity
 */

HTMLRenderer.prototype.updateChildren = function(entity) {
  var entities = this.entities;
  var children = this.children[entity.id];
  for (var path in children) {
    var childId = children[path];
    this.update(entities[childId]);
  }
};

/**
 * Clear the scene
 */

HTMLRenderer.prototype.clear =
HTMLRenderer.prototype.remove = function(){
  if (!this.rendered) return;
  this.unmountEntity(this.rendered);
  this.rendered = null;
  this.events.remove();
};

/**
 * Append an entity to an element
 *
 * @param {Entity} entity
 * @param {HTMLElement} container
 *
 * @return {HTMLElement}
 */

HTMLRenderer.prototype.mountEntity = function(entity, container) {
  var self = this;

  entity.beforeMount();

  // This will store all the entities that are children
  // of this entity after it is rendered and mounted.
  this.children[entity.id] = {};

  // Render the entity and create the initial element for it
  var current = entity.render();
  var el = this.createElement(current.root, '0', entity.id);

  // We store the DOM state of the entity within the renderer
  this.elements[entity.id] = el;
  this.renders[entity.id] = current;
  this.entities[entity.id] = entity;

  // Whenever setState or setProps is called, we mark the entity
  // as dirty in the renderer. This lets us optimize the re-rendering
  // and skip components that definitely haven't changed.
  entity.on('change', function(){
    self.dirty.push(entity.id);
  });

  container.appendChild(el);
  this.updateEvents(entity);
  entity.afterMount(el);
  return el;
};

/**
 * Remove the entity from the DOM.
 *
 * @param {Entity} entity
 */

HTMLRenderer.prototype.unmountEntity = function(entity){
  var el = this.elements[entity.id];

  // This entity is already unmounted
  if (!el) return;

  entity.beforeUnmount(el);

  // In case the entity is currently marked as dirty. We remove
  // it so it doesn't sit around in the array
  this.resolveEntity(entity);

  // If sub-components are on the root node, the entities will share
  // the same element. In this case, the element will only need to be
  // removed from the DOM once
  if (el.parentNode) el.parentNode.removeChild(el);
  this.unmountChildren(entity);
  this.removeEvents(entity);
  entity.afterUnmount();
  entity.release();
  delete this.elements[entity.id];
  delete this.renders[entity.id];
  delete this.entities[entity.id];
  delete this.children[entity.id];
};

/**
 * Remove all of the child entities of an entity
 *
 * @param {Entity} entity
 */

HTMLRenderer.prototype.unmountChildren = function(entity) {
  var self = this;
  var entities = this.entities;
  var children = this.children[entity.id];
  each(children, function(path, childId){
    self.unmountEntity(entities[childId]);
  });
};

/**
 * Updates all the DOM event bindings for an entity.
 * It removes all event bindings on the scene for this entity
 * first and just reapplies them using the current tree.
 *
 * @return {void}
 */

HTMLRenderer.prototype.updateEvents = function(entity) {
  var self = this;
  this.events.unbind(entity.id);
  var currentTree = this.renders[entity.id];

  // TODO: Optimize this by storing the events in the Tree
  // object on the initial pass instead of looping again.
  // eg. entity.current.events -> '0.0.1:click': fn
  each(currentTree.nodes, function(path, node){
    if (node.type !== 'element') return;
    each(node.events, function(eventType, fn){
      self.events.bind(entity.id, path, eventType, function(e){
        fn.call(entity.component, e, entity.props, entity.state);
      });
    });
  });
};

/**
 * Unbind all events from an entity
 *
 * @param {Entity} entity
 */

HTMLRenderer.prototype.removeEvents = function(entity) {
  this.events.unbind(entity.id);
};

/**
 * Convert this node and all it's children into
 * real DOM elements and return it.
 *
 * Passing in a node allows us to render just a small
 * part of the tree instead of the whole thing, like when
 * a new branch is added during a diff.
 *
 * @param {Node} node
 * @param {String} path
 * @param {String} entityId
 *
 * @return {HTMLDocumentFragment}
 */

HTMLRenderer.prototype.createElement = function(node, path, entityId){

  if (node.type === 'text') {
    return document.createTextNode(node.data);
  }

  if (node.type === 'element') {
    var el = document.createElement(node.tagName);
    var children = node.children;

    // TODO: These is some duplication here between the diffing.
    // This should be generalized and put into a module somewhere
    // so that it's easier to define special attributes in one spot.
    for (var name in node.attributes) {
      if (name === 'innerHTML') {
        el.innerHTML = node.attributes.innerHTML;
      } else {
        el.setAttribute(name, node.attributes[name]);
      }
    }

    // TODO: Store nodes in a hash so we can easily find
    // elements later. This would allow us to separate out the
    // patching from the diffing will still being efficient. We could
    // also use the same object in the Interactions object to make
    // lookups cleaner instead of checking __ values.
    // this.nodesByPath[entity.id][path] = el;
    el.__path__ = path;
    el.__entity__ = entityId;

    // add children.
    for (var i = 0, n = children.length; i < n; i++) {
      var childEl = this.createElement(children[i], path + '.' + i, entityId);
      el.appendChild(childEl);
    }

    return el;
  }

  if (node.type === 'component') {
    var fragment = document.createDocumentFragment();
    var child = new Entity(node.component, node.props);
    var el = this.mountEntity(child, fragment);
    this.children[entityId][path] = child.id;
    return el;
  }
};