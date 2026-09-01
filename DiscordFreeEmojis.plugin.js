/**
 * @name FreeEmojis
 * @version 1.11.3
 * @description Link emojis if you don't have nitro! Type them out or use the emoji picker!
 * @author An0 (Original) & EpicGazel 
 * @source https://github.com/EpicGazel/DiscordFreeEmojis
 * @updateUrl https://raw.githubusercontent.com/EpicGazel/DiscordFreeEmojis/master/DiscordFreeEmojis.plugin.js
 */

/*@cc_on
@if (@_jscript)
    var shell = WScript.CreateObject("WScript.Shell");
    var fs = new ActiveXObject("Scripting.FileSystemObject");
    var pathPlugins = shell.ExpandEnvironmentStrings("%APPDATA%\\BetterDiscord\\plugins");
    var pathSelf = WScript.ScriptFullName;
    shell.Popup("It looks like you've mistakenly tried to run me directly. \\n(Don't do that!)", 0, "I'm a plugin for BetterDiscord", 0x30);
    if (fs.GetParentFolderName(pathSelf) === fs.GetAbsolutePathName(pathPlugins)) {
        shell.Popup("I'm in the correct folder already.", 0, "I'm already installed", 0x40);
    } else if (!fs.FolderExists(pathPlugins)) {
        shell.Popup("I can't find the BetterDiscord plugins folder.\\nAre you sure it's even installed?", 0, "Can't install myself", 0x10);
    } else if (shell.Popup("Should I copy myself to BetterDiscord's plugins folder for you?", 0, "Do you need some help?", 0x34) === 6) {
        fs.CopyFile(pathSelf, fs.BuildPath(pathPlugins, fs.GetFileName(pathSelf)), true);
        // Show the user where to put plugins in the future
        shell.Exec("explorer " + pathPlugins);
        shell.Popup("I'm installed!", 0, "Successfully installed", 0x40);
    }
    WScript.Quit();
@else @*/


var FreeEmojis = (() => {

    'use strict';
    
    const { createElement, useState } = BdApi.React;
    const { SwitchInput } = BdApi.Components;
        
    const { DOM, Patcher, Logger, Webpack } = BdApi;
    const hideNitroCSSString = `button[class*='emojiItemDisabled'] { 
                filter: none !important; 
                outline: dotted 4px rgba(255, 255, 255, 0.46); 
                outline-offset: -2px; 
                cursor: pointer !important;
            }
    
            /* Makes the emoji lock icon itself too small to see */
            [class*="emojiLockIcon"] {
                width: 0 !important;
            }
    
            /* Hides lock on server icons */
            [class*="categoryItemLockIconContainer"] {
                display: none;
            }
    
            /* Hides the "Unlock every emoji with Nitro - Get Nitro" pop-up */
            /* Disabled for now, breaks server settings "Onboarding" page.
            [class*="upsellContainer_"] {
                display: none;
            }
            */
    
            /* Hides the divider between "Frequently Used" and server emojis */
            [class*="nitroTopDividerContainer"] {
                display: none;
            }
    
            /* Makes the pink background behind "locked" emojis transparent. */
            [class*="categorySectionNitroLocked"] {
                background: transparent !important;
            }
            `;
    const miscellaneousCSS = `/* Other misc rules */
                /* Make (normal) text emojis bigger */
                .emoji.jumboable {
                    width:150px;
                    height:150px;
                }
    
                /* Really big emoji/sticker/gif drawer */
                [class*="expressionPickerPositionLayer"] {
                    height: calc(100vh - 220px);
                }
    
                /* Hide send gift button */
                div[aria-label="Send a gift"] {
                    visibility: hidden;
                    display: none;
                }`;
    var css = "";
    // Size (px) used for the "stk:ID" sticker shortcut links. Change this
    // number if you want stickers sent bigger/smaller.
    const STICKER_SIZE = 160;

    // Permiso de Discord "Usar emojis externos" (bit 18 -> 2^18 = 0x40000).
    // Los permisos de Discord son flags de 53+ bits, por eso se usa BigInt.
    const USE_EXTERNAL_EMOJIS_PERMISSION = 0x40000n;

    // Se resuelve en Start() porque Webpack aún no tiene los módulos listos
    // cuando se evalúa este IIFE.
    let permissionStoreRef = null;
        
    var pluginSettings = {
        useNativeEmojiSize: {
            name: "Use native emoji size",
            note: "Uploads emoji as their native size. Always scales down to 48px, the Discord emoji size, otherwise.",
            value: false
        },
        hideNitroCss: {
            name: "Hide Nitro CSS",
            note: "Removes Nitro adds using CSS.",
            value: true
        },
        enableMiscellaneousCSS:{
            name: "Enable Miscellaneous CSS properties",
            note: "Other CSS styles that you may or may not like. Bigger emojis, bigger emoji drawer, hide gift button...",
            value: false
        },
        invisibleEmojiLink: {
        name: "Invisible Emoji Link",
        note: "If enabled, emojis are embedded as an invisible markdown link. If disabled, they are sent as a plain URL instead.",
        value: true
        },
        usePngFormat: {
        name: "Usar formato PNG",
        note: "Aplica solo a emojis ESTÁTICOS: si está activado, usan .png (más compatible con algunos clientes móviles como Android); si está desactivado, usan .webp. Los emojis animados siempre se envían como .gif para que se reproduzcan correctamente.",
        value: false
        }
    };
        
    function Start() {
        permissionStoreRef = Webpack.getStore('PermissionStore');
        if (permissionStoreRef == null) {
            Logger.warn("FreeEmojis", "PermissionStore no encontrado; se omitirá la verificación de permisos de canal y se asumirá disponible (fail-open).");
        }

        let emojisModule = Webpack.getByKeys('getDisambiguatedEmojiContext', 'searchWithoutFetchingLatest');
        if(emojisModule == null) { Logger.error("FreeEmojis", "emojisModule not found."); return 0; }
        Patcher.after("FreeEmojis", emojisModule, "searchWithoutFetchingLatest", (_, __, result) => {
            result.unlocked.push(...result.locked);
            result.locked = [];
        });

        let messageEmojiParserModule = Webpack.getByKeys('parse', 'parsePreprocessor', 'unparse');
        if(messageEmojiParserModule == null) { Logger.error("FreeEmojis", "messageEmojiParserModule not found."); return 0; }
        Patcher.after("FreeEmojis", messageEmojiParserModule, "parse", (_, args, result) => {
            let emojisSent = 0;

            // args[0] es el objeto del canal destino (incluye guild_id).
            // Lo necesitamos para verificar el permiso real "Usar emojis
            // externos", que es independiente del Nitro de la cuenta.
            const targetChannel = args[0];

            if(result.invalidEmojis.length !== 0) {
                for(let emoji of result.invalidEmojis) {
                    let index = Math.floor(Math.random() * 100000);
                    replaceEmoji(result, emoji, index);
                }
                result.invalidEmojis = [];
            }
            let validNonShortcutEmojis = result.validNonShortcutEmojis;
            for (let i = 0; i < validNonShortcutEmojis.length; i++) {
                const emoji = validNonShortcutEmojis[i];
                if(!isEmojiTrulyAvailable(emoji, targetChannel)) {
                    replaceEmoji(result, emoji, emojisSent);
                    emojisSent++;
                    validNonShortcutEmojis.splice(i, 1);
                    i--;
                }
            }

            // Sticker shortcut: typing "stk:STICKER_ID" in the message gets
            // replaced with a resized image link via Discord's media proxy
            // (media.discordapp.net supports width/height resizing for
            // stickers; cdn.discordapp.com does not).
            const stickerShortcutRegex = /stk:(\d{15,25})/g;
            result.content = result.content.replace(stickerShortcutRegex, (_match, stickerId) => {
                const size = STICKER_SIZE;
                const stickerUrl = `https://media.discordapp.net/stickers/${stickerId}.png?width=${size}&height=${size}`;
                return pluginSettings.invisibleEmojiLink.value ? `[󠄀](${stickerUrl}) ` : stickerUrl;
            });
        });

        let emojiPermissionsModule = Webpack.getByKeys('getEmojiUnavailableReason');
        if(emojiPermissionsModule == null) { Logger.error("FreeEmojis", "emojiPermissionsModule not found."); return 0; }
        Patcher.instead("FreeEmojis", emojiPermissionsModule, "getEmojiUnavailableReason", () => null);

        // NOTE: We intentionally do NOT patch isEmojiFiltered here.
        // Forcing it to false made Discord think restricted-server emojis
        // were "available", which skipped our own URL-replacement fallback
        // below (replaceEmoji only runs when !emoji.available). The message
        // was then sent as a raw <:name:id> tag, which Discord's server
        // rejects for real once it validates the "Use External Emojis"
        // permission — reverting the message back to plain ":name:" text a
        // moment after sending. Leaving isEmojiFiltered alone keeps
        // emoji.available correctly false in restricted servers, so the
        // URL-link fallback below still triggers on send. Trade-off: the
        // picker still shows these emojis as greyed-out/locked visually in
        // restricted servers, but sending by typing/autocomplete works.
    
        // Verifica el permiso real de Discord "Usar emojis externos" para
        // el canal destino. Fail-open (retorna true) si no hay canal o si
        // el PermissionStore no está disponible/cambia de forma - preferible
        // a bloquear el envío de mensajes por un fallo interno de Discord.
        function canUseExternalEmojis(channel) {
            if (!channel || permissionStoreRef == null) return true;
            try {
                return Boolean(permissionStoreRef.can(USE_EXTERNAL_EMOJIS_PERMISSION, channel));
            } catch (error) {
                Logger.warn("FreeEmojis", "Fallo al verificar el permiso 'Usar emojis externos'; se asume disponible.", error);
                return true;
            }
        }

        // Un emoji es realmente utilizable si:
        //  a) pertenece al mismo servidor que el canal destino (nunca
        //     requiere el permiso "Usar emojis externos", solo aplica a
        //     emojis foráneos), o
        //  b) el usuario tiene Nitro suficiente (emoji.available) Y el
        //     canal destino permite emojis externos.
        // Ambas condiciones son independientes en Discord; hacía falta
        // verificar las dos, no solo emoji.available.
        function isEmojiTrulyAvailable(emoji, channel) {
            if (!emoji) return true; // nada que reemplazar, deja pasar

            const isNativeToChannel = channel != null && emoji.guildId === channel.guild_id;
            if (isNativeToChannel) return true;

            return emoji.available !== false && canUseExternalEmojis(channel);
        }

        function replaceEmoji(parseResult, emoji, index) {
            // Build Embed URL
            // IMPORTANT: cdn.discordapp.com solo reproduce animación de forma
            // fiable con la extensión ".gif". El parámetro "&animated=true"
            // sobre webp/png NO fuerza animación ahí (por eso los emojis
            // animados se veían como imagen estática/png). Por lo tanto, si
            // el emoji es animado, ignoramos el toggle "usePngFormat" (que
            // ahora solo decide el formato de los emojis ESTÁTICOS) y usamos
            // siempre .gif.
            var emojiExtension = emoji.animated
                ? "gif"
                : (pluginSettings.usePngFormat.value ? "png" : "webp");
            var emojiUrl = `https://cdn.discordapp.com/emojis/${emoji.id}.${emojiExtension}`;

            // Index allows for duplicate emojis (multiple of the same one), otherwise there would only be one embed
            emojiUrl += `?quality=lossless&${index}`;

            // If not native (full size), will use the discord default size (48px)
            // We also add explicit width/height (not just "size"), since some
            // clients build the inline preview from width/height metadata
            // rather than the "size" query param.
            if (!pluginSettings.useNativeEmojiSize.value) {
                emojiUrl += "&size=48&width=48&height=48";
            }


            // Building string to in message
            var replaceString = "<"

            if (emoji.animated)
                replaceString += "a";

            replaceString += ":";

            if (emoji.originalName)
                replaceString += emoji.originalName;
            else
                replaceString += emoji.name;

            replaceString += ":" + emoji.id + ">";
            
            var replacement = ""

            //Make emoji invisible via markdown link and invisible character
            if (pluginSettings.invisibleEmojiLink.value)
                replacement = `[󠄀](${emojiUrl}) `;
            else
                replacement = emojiUrl;

            parseResult.content = parseResult.content.replace(replaceString, replacement);
            }

    
        for (let key in pluginSettings) {
            const loadedSetting = BdApi.Data.load("FreeEmojis", key);
    
            if (loadedSetting == undefined) {
                BdApi.Data.save("FreeEmojis", key, pluginSettings[key].value);
            } else {
                pluginSettings[key].value = loadedSetting;
            }
        }

        // Set CSS
        if (pluginSettings.hideNitroCss.value)
            css += hideNitroCSSString;
     
         if (pluginSettings.enableMiscellaneousCSS.value)
             css += miscellaneousCSS;
    
        DOM.addStyle('FreeEmojis', css)	
    }
    
    function Stop() {       
        DOM.removeStyle('FreeEmojis')
        Patcher.unpatchAll('FreeEmojis')
    }
    
    function GetSettingsPanel() {
        const settingsElement = () => {

            const [usePluginSettings, setPluginSettings] = useState(pluginSettings);
            const handleChange = (key, value) => {
                let updatedSettings = { ...usePluginSettings };
                updatedSettings[key].value = value
                setPluginSettings(updatedSettings);
                BdApi.Data.save("FreeEmojis", key, value);

                // Update CSS
                css = "";
                if (pluginSettings.hideNitroCss.value)
                    css += hideNitroCSSString;
             
                if (pluginSettings.enableMiscellaneousCSS.value)
                     css += miscellaneousCSS;

                // Reload CSS
                DOM.removeStyle('FreeEmojis')
                DOM.addStyle('FreeEmojis', css)
            }

            return Object.keys(pluginSettings).map((key) => {
                let { name, note, value } = pluginSettings[key];
                return createElement(
                    "div",
                    {
                        style: {
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "16px 0",
                            borderBottom: "1px solid rgba(255,255,255,0.04)"
                        }
                    },
                    createElement("div", { style: { flex: 1, minWidth: 0 } },
                        createElement("div", { style: { fontWeight: 500, fontSize: 16, color: "#fff" } }, name),
                        note && createElement("div", { style: { fontSize: 13, color: "#b9bbbe", marginTop: 4, lineHeight: "1.4" } }, note)
                    ),
                    createElement(SwitchInput, {
                        value: value,
                        onChange: (v) => handleChange(key, v)
                    })
                );
            });
        };

        return createElement(settingsElement);
    }
    
    return function() { return {
        start: Start,
        stop: Stop,
        getSettingsPanel: GetSettingsPanel
    }};
    
})();
    
module.exports = FreeEmojis;
    
/*@end @*/
