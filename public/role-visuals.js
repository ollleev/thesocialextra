// Public category tokens only. Availability, ownership and selection never
// affect these colours; the adjacent role name remains the primary cue.
const definitions = [
  ['Serveur', 'service', 'utensils', '#17645f', '#e3f2ee'],
  ['Barman', 'bar', 'wine', '#753c79', '#f4e9f4'],
  ['Chef de rang', 'rang', 'utensils', '#365685', '#e7edf7'],
  ['Maître d’hôtel', 'salle', 'utensils', '#854c31', '#f6ece4'],
  ['Plongeur', 'plonge', 'utensils', '#246786', '#e2f1f7'],
  ['Commis', 'commis', 'chef-hat', '#626c26', '#eef1db'],
  ['Cuisinier', 'cuisine', 'chef-hat', '#914521', '#f9ebe2'],
  ['Pizzaiolo', 'pizza', 'chef-hat', '#873e47', '#f6e7e9'],
  ['Pâtissier', 'patisserie', 'chef-hat', '#8b3d6b', '#f7e7f0'],
  ['Traiteur', 'traiteur', 'utensils', '#765a1d', '#f5eedc'],
  ['Manager', 'manager', 'briefcase-business', '#4c536c', '#e9ecf3'],
  ['Hôte / Hôtesse', 'accueil', 'briefcase-business', '#59509a', '#edeafa'],
];
const visuals = new Map(definitions.map(([role, key, icon, ink, paper]) => [role, Object.freeze({key, icon, ink, paper})]));
const neutral = Object.freeze({key:'other', icon:'briefcase-business', ink:'#59615c', paper:'#eef0ec'});

export function roleVisual(role) {
  return typeof role === 'string' ? visuals.get(role) || neutral : neutral;
}
