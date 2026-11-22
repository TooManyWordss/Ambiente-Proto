import { menuCatalog } from '../../menu-catalog.js';

// Dish descriptions, kept apart from the menu routes so other modules can use them without registering routes.
export const catalogDetails = new Map(menuCatalog.map(item => [`${item.category}|${item.name}`, {
  description: item.description, descriptionNote: item.descriptionNote, descriptionSources: item.descriptionSources,
}]));
// A dish's description: the owner's own once they've written one (even an empty one), otherwise the menu's.
export const dishDetails = (item, store) => item.description != null ? { description: item.description }
  : store === 'ambiente' ? catalogDetails.get(`${item.category}|${item.name}`) : undefined;
export function descriptionProblem(description) {
  return description !== undefined && (typeof description !== 'string' || description.length > 600) ? 'Description must be up to 600 characters' : null;
}
