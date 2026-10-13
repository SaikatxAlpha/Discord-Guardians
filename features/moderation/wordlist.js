// Baseline profanity lists (English + common Hinglish). Guilds extend these
// with moderation.profanity.extraWords and relax them with allowWords.
// "severe" covers slurs and hate terms; "mild" covers general profanity.

export const MILD = [
  'fuck', 'fucker', 'fucking', 'motherfucker', 'shit', 'bullshit', 'bitch', 'bastard', 'asshole', 'dick', 'dickhead',
  'pussy', 'cunt', 'wanker', 'prick', 'twat', 'slut', 'whore', 'cock', 'jerkoff', 'dumbass', 'jackass',
  // Hinglish
  'madarchod', 'behenchod', 'bhenchod', 'chutiya', 'chutiye', 'bhosdike', 'bhosdi', 'gaandu', 'randi', 'harami', 'lauda', 'lavda', 'lodu',
  // "mc"/"bc" are deliberately excluded: too many false positives (Minecraft, BC dates).
];

export const SEVERE = [
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'tranny', 'chink', 'spic', 'kike', 'paki', 'coon', 'gook', 'wetback',
  'kys', 'killyourself',
];

// Innocent words containing listed substrings (Scunthorpe problem).
export const DEFAULT_ALLOW = [
  'scunthorpe', 'cockpit', 'cocktail', 'peacock', 'hancock', 'shitake', 'shiitake', 'dickens', 'dickinson', 'assassin',
  'classic', 'bassist', 'pakistan', 'pakistani', 'raccoon', 'cocoon', 'tycoon', 'spice', 'spicy', 'niggardly', 'retardant',
  'snigger', 'mcdonalds', 'bcc', 'abc', 'mcq',
];
