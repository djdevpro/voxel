// Pas de console à côté de la fenêtre dans l'appli publiée sous Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    voxel_desktop_lib::run()
}
