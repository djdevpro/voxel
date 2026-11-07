//! Pastille des non-lus, dessinée en RGBA sans bibliothèque d'images : un disque rouge anticrénelé et le nombre en blanc (1 à 9, puis « 9+ »), tracé avec une petite police matricielle agrandie et lissée. Seule, elle est l'icône de superposition du bouton de la barre des tâches (Windows) ; posée en bas à droite, elle marque l'icône de la zone de notification.

/// Rouge de la pastille, #D13438.
const RED: [f32; 3] = [
    0xD1 as f32 / 255.0,
    0x34 as f32 / 255.0,
    0x38 as f32 / 255.0,
];
/// Côté de l'icône de superposition ; Windows la réduit lui-même à la taille du bouton.
#[cfg(any(windows, test))]
pub(crate) const OVERLAY_SIZE: u32 = 32;
/// Plus grand côté de l'icône de la zone de notification : au-delà (512 px sous Linux), l'icône de l'appli est réduite.
pub(crate) const TRAY_MAX: u32 = 64;
/// Diamètre de la pastille de la zone de notification, en part du côté de l'icône.
const TRAY_BADGE: f32 = 0.6;
/// Hauteur du texte, en part du diamètre.
const TEXT_HEIGHT: f32 = 0.55;
/// Largeur maximale du texte, en part du diamètre : « 9+ » tient dans le disque.
const TEXT_WIDTH: f32 = 0.7;
/// Sous-échantillons par côté de pixel pour lisser les caractères.
const SAMPLES: u32 = 4;
/// Colonnes d'un caractère de la police.
const GLYPH_WIDTH: usize = 5;
/// Lignes d'un caractère de la police.
const GLYPH_HEIGHT: usize = 7;
/// Colonnes vides entre deux caractères.
const GLYPH_GAP: usize = 1;
/// Graisse : chaque case allumée déborde d'autant à droite et en bas, pour des traits lisibles à 16 px.
const BOLD: f32 = 0.5;

type Glyph = [u8; GLYPH_HEIGHT];

/// Chiffres de la police 5 × 7 : une ligne par octet, de haut en bas, le bit 4 à gauche.
const DIGITS: [Glyph; 10] = [
    [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
    [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
    [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
    [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E],
    [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
    [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
    [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
    [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
    [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
    [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
];
/// « + » de « 9+ ».
const PLUS: Glyph = [0x00, 0x04, 0x04, 0x1F, 0x04, 0x04, 0x00];

/// Image RGBA 8 bits, rangée par lignes de haut en bas, comme `tauri::image::Image`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Rgba {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl Rgba {
    fn transparent(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            pixels: vec![0; width as usize * height as usize * 4],
        }
    }
}

/// Texte de la pastille : rien à 0, le nombre de 1 à 9, « 9+ » au-delà.
pub(crate) fn label(count: u32) -> Option<String> {
    match count {
        0 => None,
        1..=9 => Some(count.to_string()),
        _ => Some("9+".to_string()),
    }
}

/// Icône de superposition du bouton de la barre des tâches : la pastille seule sur fond transparent ; rien à 0.
#[cfg(any(windows, test))]
pub(crate) fn overlay(count: u32) -> Option<Rgba> {
    let text = label(count)?;
    let mut image = Rgba::transparent(OVERLAY_SIZE, OVERLAY_SIZE);
    draw(&mut image, 0, 0, OVERLAY_SIZE, &text);
    Some(image)
}

/// Icône de la zone de notification : la base avec la pastille en bas à droite ; la base telle quelle à 0.
pub(crate) fn tray(base: &Rgba, count: u32) -> Rgba {
    let mut image = base.clone();
    let side = base.width.min(base.height);
    if let Some(text) = label(count)
        && side > 0
    {
        let diameter = ((side as f32 * TRAY_BADGE).round() as u32).clamp(1, side);
        draw(
            &mut image,
            base.width - diameter,
            base.height - diameter,
            diameter,
            &text,
        );
    }
    image
}

/// Réduit l'icône à `max` pixels de côté au plus, par moyenne des pixels couverts (pondérée par l'opacité, sans liseré sombre).
pub(crate) fn shrink(icon: &Rgba, max: u32) -> Rgba {
    let longest = icon.width.max(icon.height);
    if longest <= max || icon.width == 0 || icon.height == 0 || max == 0 {
        return icon.clone();
    }
    let width = (icon.width * max / longest).max(1);
    let height = (icon.height * max / longest).max(1);
    let mut image = Rgba::transparent(width, height);
    for y in 0..height {
        let (top, bottom) = span(y, height, icon.height);
        for x in 0..width {
            let (left, right) = span(x, width, icon.width);
            // Couleurs prémultipliées par l'opacité, puis opacité.
            let mut sum = [0u64; 3];
            let mut opacity = 0u64;
            for source_y in top..bottom {
                for source_x in left..right {
                    let at = (source_y as usize * icon.width as usize + source_x as usize) * 4;
                    let pixel = &icon.pixels[at..at + 4];
                    let alpha = u64::from(pixel[3]);
                    for (total, &value) in sum.iter_mut().zip(&pixel[..3]) {
                        *total += u64::from(value) * alpha;
                    }
                    opacity += alpha;
                }
            }
            if opacity == 0 {
                continue;
            }
            let count = u64::from((right - left) * (bottom - top));
            let at = (y as usize * width as usize + x as usize) * 4;
            let pixel = &mut image.pixels[at..at + 4];
            for (value, total) in pixel[..3].iter_mut().zip(sum) {
                *value = ((total + opacity / 2) / opacity) as u8;
            }
            pixel[3] = ((opacity + count / 2) / count) as u8;
        }
    }
    image
}

/// Lignes (ou colonnes) de la source couvertes par la case `index` sur `target` : au moins une.
fn span(index: u32, target: u32, source: u32) -> (u32, u32) {
    let start = u64::from(index) * u64::from(source) / u64::from(target);
    let end = (u64::from(index) + 1) * u64::from(source);
    let end = end.div_ceil(u64::from(target)).max(start + 1);
    (start as u32, end.min(u64::from(source)) as u32)
}

/// Place du texte dans le carré du disque : coin haut gauche en pixels et côté d'une case de la police.
struct Layout {
    left: f32,
    top: f32,
    unit: f32,
}

fn layout(diameter: f32, glyphs: usize) -> Layout {
    let columns = (glyphs * GLYPH_WIDTH + glyphs.saturating_sub(1) * GLYPH_GAP) as f32 + BOLD;
    let rows = GLYPH_HEIGHT as f32 + BOLD;
    let unit = (diameter * TEXT_HEIGHT / rows).min(diameter * TEXT_WIDTH / columns);
    Layout {
        // Calé sur le pixel : des bords nets.
        left: ((diameter - columns * unit) / 2.0).round(),
        top: ((diameter - rows * unit) / 2.0).round(),
        unit,
    }
}

fn glyph(character: char) -> Option<&'static Glyph> {
    match character {
        '+' => Some(&PLUS),
        _ => DIGITS.get(character.to_digit(10)? as usize),
    }
}

/// Pose la pastille de diamètre `diameter` dans le carré de coin (`left`, `top`), par-dessus l'image.
fn draw(image: &mut Rgba, left: u32, top: u32, diameter: u32, text: &str) {
    let glyphs: Vec<&Glyph> = text.chars().filter_map(glyph).collect();
    let size = diameter as f32;
    let radius = size / 2.0;
    let place = layout(size, glyphs.len());
    for y in top..(top + diameter).min(image.height) {
        for x in left..(left + diameter).min(image.width) {
            let (inside_x, inside_y) = ((x - left) as f32, (y - top) as f32);
            let (dx, dy) = (inside_x + 0.5 - radius, inside_y + 0.5 - radius);
            // Part du pixel couverte par le disque, sur un pixel de bord.
            let disc = (radius + 0.5 - (dx * dx + dy * dy).sqrt()).clamp(0.0, 1.0);
            if disc <= 0.0 {
                continue;
            }
            let ink = ink(
                &glyphs,
                (inside_x - place.left) / place.unit,
                (inside_y - place.top) / place.unit,
                1.0 / place.unit,
            );
            let color = RED.map(|red| red + (1.0 - red) * ink);
            blend(image, x, y, color, disc);
        }
    }
}

/// Part du pixel couverte par le texte ; (`u`, `v`) est son coin haut gauche en cases de la police, `step` son côté.
fn ink(glyphs: &[&Glyph], u: f32, v: f32, step: f32) -> f32 {
    let mut lit = 0;
    for row in 0..SAMPLES {
        for column in 0..SAMPLES {
            let sample_u = u + (column as f32 + 0.5) / SAMPLES as f32 * step;
            let sample_v = v + (row as f32 + 0.5) / SAMPLES as f32 * step;
            if is_lit(glyphs, sample_u, sample_v) {
                lit += 1;
            }
        }
    }
    lit as f32 / (SAMPLES * SAMPLES) as f32
}

fn is_lit(glyphs: &[&Glyph], u: f32, v: f32) -> bool {
    [(0.0, 0.0), (BOLD, 0.0), (0.0, BOLD), (BOLD, BOLD)]
        .iter()
        .any(|&(right, down)| in_cell(glyphs, u - right, v - down))
}

fn in_cell(glyphs: &[&Glyph], u: f32, v: f32) -> bool {
    if u < 0.0 || v < 0.0 {
        return false;
    }
    let (column, row) = (u as usize, v as usize);
    let pitch = GLYPH_WIDTH + GLYPH_GAP;
    let Some(glyph) = glyphs.get(column / pitch) else {
        return false;
    };
    let column = column % pitch;
    row < GLYPH_HEIGHT
        && column < GLYPH_WIDTH
        && (glyph[row] >> (GLYPH_WIDTH - 1 - column)) & 1 == 1
}

/// Composition « par-dessus » d'une couleur d'opacité `alpha` sur un pixel non prémultiplié.
fn blend(image: &mut Rgba, x: u32, y: u32, color: [f32; 3], alpha: f32) {
    let at = (y as usize * image.width as usize + x as usize) * 4;
    let pixel = &mut image.pixels[at..at + 4];
    let below = f32::from(pixel[3]) / 255.0;
    let total = alpha + below * (1.0 - alpha);
    if total <= 0.0 {
        return;
    }
    for (value, paint) in pixel[..3].iter_mut().zip(color) {
        let mixed = (paint * alpha + f32::from(*value) / 255.0 * below * (1.0 - alpha)) / total;
        *value = (mixed * 255.0).round().clamp(0.0, 255.0) as u8;
    }
    pixel[3] = (total * 255.0).round().clamp(0.0, 255.0) as u8;
}

#[cfg(test)]
mod tests {
    use super::*;

    const RED_PIXEL: [u8; 4] = [0xD1, 0x34, 0x38, 0xFF];
    const WHITE_PIXEL: [u8; 4] = [0xFF, 0xFF, 0xFF, 0xFF];

    fn pixel(image: &Rgba, x: u32, y: u32) -> [u8; 4] {
        let at = (y as usize * image.width as usize + x as usize) * 4;
        image.pixels[at..at + 4].try_into().unwrap()
    }

    /// Icône de base opaque, en dégradé : chaque pixel est différent de ses voisins.
    fn base(side: u32) -> Rgba {
        let mut image = Rgba::transparent(side, side);
        for y in 0..side {
            for x in 0..side {
                let at = (y * side + x) as usize * 4;
                image.pixels[at..at + 4].copy_from_slice(&[
                    (x * 7) as u8,
                    (y * 5) as u8,
                    0x60,
                    0xFF,
                ]);
            }
        }
        image
    }

    /// Centre, en pixels du carré du disque, de la case (`column`, `row`) du caractère `index`.
    fn cell_center(
        diameter: u32,
        glyphs: usize,
        index: usize,
        column: usize,
        row: usize,
    ) -> (u32, u32) {
        let place = layout(diameter as f32, glyphs);
        let column = (index * (GLYPH_WIDTH + GLYPH_GAP) + column) as f32 + 0.5;
        let row = row as f32 + 0.5;
        (
            (place.left + column * place.unit) as u32,
            (place.top + row * place.unit) as u32,
        )
    }

    #[test]
    fn label_caps_at_nine_plus() {
        assert_eq!(label(0), None);
        assert_eq!(label(1).as_deref(), Some("1"));
        assert_eq!(label(9).as_deref(), Some("9"));
        assert_eq!(label(10).as_deref(), Some("9+"));
        assert_eq!(label(u32::MAX).as_deref(), Some("9+"));
    }

    #[test]
    fn font_covers_digits_and_plus() {
        assert!("0123456789+".chars().all(|c| glyph(c).is_some()));
        assert!(glyph('a').is_none());
    }

    #[test]
    fn no_badge_at_zero() {
        assert!(overlay(0).is_none());
        let base = base(32);
        assert_eq!(tray(&base, 0), base);
    }

    #[test]
    fn overlay_is_a_red_disc_with_white_text() {
        let image = overlay(1).unwrap();
        assert_eq!((image.width, image.height), (OVERLAY_SIZE, OVERLAY_SIZE));
        assert_eq!(image.pixels.len(), 32 * 32 * 4);
        for (x, y) in [(0, 0), (31, 0), (0, 31), (31, 31)] {
            assert_eq!(pixel(&image, x, y)[3], 0, "coin ({x}, {y}) transparent");
        }
        // Dans le disque, à gauche du texte : rouge plein.
        assert_eq!(pixel(&image, 3, 16), RED_PIXEL);
        // Le fût du « 1 » (colonne 2, ligne 3) : blanc plein.
        let (x, y) = cell_center(OVERLAY_SIZE, 1, 0, 2, 3);
        assert_eq!(pixel(&image, x, y), WHITE_PIXEL);
        // À côté du fût (colonne 0, ligne 3) : pas d'encre.
        let (x, y) = cell_center(OVERLAY_SIZE, 1, 0, 0, 3);
        assert_eq!(pixel(&image, x, y), RED_PIXEL);
    }

    #[test]
    fn overlay_draws_nine_plus_inside_the_disc() {
        let image = overlay(42).unwrap();
        // La barre du « + » (caractère 1, colonne 0, ligne 3) et la boucle du « 9 » (colonne 0, ligne 1).
        let (x, y) = cell_center(OVERLAY_SIZE, 2, 1, 0, 3);
        assert_eq!(pixel(&image, x, y), WHITE_PIXEL);
        let (x, y) = cell_center(OVERLAY_SIZE, 2, 0, 0, 1);
        assert_eq!(pixel(&image, x, y), WHITE_PIXEL);
        // Aucun pixel de texte au bord du disque : tout pixel clair est opaque.
        for y in 0..OVERLAY_SIZE {
            for x in 0..OVERLAY_SIZE {
                let [_, green, _, alpha] = pixel(&image, x, y);
                if green > 0x80 {
                    assert_eq!(alpha, 0xFF, "texte hors du disque en ({x}, {y})");
                }
            }
        }
    }

    #[test]
    fn tray_badge_sits_bottom_right_and_keeps_the_rest() {
        let base = base(32);
        let image = tray(&base, 3);
        assert_eq!((image.width, image.height), (32, 32));
        let diameter = (32.0 * TRAY_BADGE).round() as u32;
        let corner = 32 - diameter;
        for y in 0..32 {
            for x in 0..32 {
                if x < corner || y < corner {
                    assert_eq!(
                        pixel(&image, x, y),
                        pixel(&base, x, y),
                        "({x}, {y}) inchangé"
                    );
                }
            }
        }
        // Coin du carré de la pastille, hors du disque : la base.
        assert_eq!(pixel(&image, corner, corner), pixel(&base, corner, corner));
        // Bord gauche du disque, à mi-hauteur : rouge plein.
        assert_eq!(pixel(&image, corner + 1, corner + diameter / 2), RED_PIXEL);
        // Le « 3 » : sa barre du haut (colonne 0, ligne 0).
        let (x, y) = cell_center(diameter, 1, 0, 0, 0);
        assert_eq!(pixel(&image, corner + x, corner + y), WHITE_PIXEL);
    }

    #[test]
    fn tray_badge_fits_on_any_icon_size() {
        for side in [1, 2, 16, 24, 48, 64, 512] {
            let image = tray(&base(side), 7);
            assert_eq!(image.pixels.len(), (side * side * 4) as usize);
        }
        let empty = Rgba::transparent(0, 0);
        assert_eq!(tray(&empty, 5), empty);
    }

    #[test]
    fn shrink_averages_and_keeps_small_icons() {
        let small = base(48);
        assert_eq!(shrink(&small, TRAY_MAX), small);

        let mut flat = Rgba::transparent(512, 512);
        for chunk in flat.pixels.chunks_mut(4) {
            chunk.copy_from_slice(&[10, 120, 230, 255]);
        }
        let shrunk = shrink(&flat, TRAY_MAX);
        assert_eq!((shrunk.width, shrunk.height), (64, 64));
        assert!(shrunk.pixels.chunks(4).all(|p| p == [10, 120, 230, 255]));

        // Un pixel rouge opaque parmi trois transparents : rouge, au quart d'opacité, sans noircir.
        let mut sparse = Rgba::transparent(2, 2);
        sparse.pixels[..4].copy_from_slice(&[200, 0, 0, 255]);
        let one = shrink(&sparse, 1);
        assert_eq!(one.pixels, vec![200, 0, 0, 64]);
    }

    #[test]
    fn shrink_keeps_the_aspect_ratio() {
        let wide = Rgba::transparent(256, 128);
        let shrunk = shrink(&wide, 64);
        assert_eq!((shrunk.width, shrunk.height), (64, 32));
    }
}
