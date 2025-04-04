// Подключаем нужные пакеты
import dotenv from 'dotenv';
dotenv.config();

import { Telegraf, Markup } from 'telegraf';
import { Client } from '@notionhq/client';

// Инициализируем бота и клиента Notion
const bot = new Telegraf(process.env.BOT_TOKEN);
const notion = new Client({ auth: process.env.NOTION_API_KEY });

// ID базы данных Notion
const databaseId = process.env.NOTION_DB_ID;

// Глобальные переменные для хранения опций Select
let categoryOptions = [];
let subcatOptions = [];
let accountOptions = [];

// Временное хранилище для каждого пользователя
// userState[userId] = { sum, title, currency, dateString, category, subcategory, account }
const userState = {};

/**
 * Функция для получения русского названия месяца по индексу (0..11).
 */
function getRussianMonthName(monthIndex) {
    const months = [
        'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
        'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
    ];
    return months[monthIndex] || 'Неизвестный месяц';
}

function isValidCurrency(str) {
    const allowedCurrencies = ['TRY', 'GEL', 'USD', 'RUB'];
    return allowedCurrencies.includes(str.toUpperCase());
}

function isValidShortDateFormat(str) {
    return /^\d{6}$/.test(str); // 6 цифр
}

/**
 * Преобразование ддммгг → Date (UTC).
 * Если yy < 50 => 20yy, иначе => 19yy
 */
function parseShortDateString(str) {
    // ддммгг -> yyyy-mm-dd
    const dd = parseInt(str.slice(0, 2), 10);
    const mm = parseInt(str.slice(2, 4), 10);
    const yy = parseInt(str.slice(4, 6), 10);

    // if yy<50 => 20yy, else => 19yy
    let fullYear = (yy < 50) ? (2000 + yy) : (1900 + yy);

    // Создаём дату в UTC
    return new Date(Date.UTC(fullYear, mm - 1, dd, 12));
}


/**
 * Парсим строку вида "3000 такси USD 020225".
 * Формат: <сумма> <название ...> [валюта] [ддммгг]
 */
function parseUserInput(input) {
    const tokens = input.trim().split(/\s+/);
    if (!tokens.length) return null;

    // 1) Сумма (первый токен)
    const sumRaw = tokens[0];
    const sum = parseFloat(sumRaw.replace(',', '.'));
    if (isNaN(sum)) {
        return null;
    }

    // Список оставшихся частей
    let remaining = tokens.slice(1);

    let currency = 'RUB';
    let dateString = null;

    // Проверяем последний токен, может это дата (6 цифр)
    let lastToken = remaining[remaining.length - 1];
    if (lastToken && isValidShortDateFormat(lastToken)) {
        dateString = lastToken;
        remaining.pop();
        lastToken = remaining[remaining.length - 1];
    }

    // Теперь проверим, вдруг этот lastToken - валюта
    if (lastToken && isValidCurrency(lastToken)) {
        currency = lastToken.toUpperCase();
        remaining.pop();
        lastToken = remaining[remaining.length - 1];
    }

    // Всё, что осталось - название
    const title = remaining.join(' ').trim() || '(без названия)';

    return { sum, title, currency, dateString };
}

// Загрузим схему базы и извлечём варианты select
const dbInfo = await notion.databases.retrieve({ database_id: databaseId });

const catProp = dbInfo.properties['Категория'];
const subcatProp = dbInfo.properties['Подкатегория'];
const accountProp = dbInfo.properties['Счёт'];

if (catProp?.type === 'select') {
    categoryOptions = catProp.select.options;
}
if (subcatProp?.type === 'select') {
    subcatOptions = subcatProp.select.options;
}
if (accountProp?.type === 'select') {
    accountOptions = accountProp.select.options;
}

console.log('БД из Notion:', dbInfo);
console.log('Категории из Notion:', categoryOptions.map(o => o.name));
console.log('Подкатегории из Notion:', subcatOptions.map(o => o.name));
console.log('Счета из Notion:', accountOptions.map(o => o.name));

// Команда /start — приветствие
bot.start((ctx) => {
    ctx.reply(
        'Привет! Для добавления операции введи:\n' +
        'сумма название [валюта] [ддммгггг]\n\n' +
        'Примеры:\n' +
        '"300 такси до отеля"\n' +
        '"300 такси до отеля USD"\n' +
        '"300 такси до отеля USD 090425"\n' +
        '"500 продукты 150425"\n'
    );
});

// При вводе текста парсим данные
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const parsed = parseUserInput(ctx.message.text);
    if (!parsed) {
        return ctx.reply(
            'Не удалось распознать данные. Формат: "300 Название [валюта] [ддммгг]"'
        );
    }

    const { sum, title, currency, dateString } = parsed;

    // Сохраняем во временное состояние
    userState[userId] = {
        sum,
        title,
        currency,
        dateString,
        category: null,
        subcategory: null,
        account: null
    };

    // Предлагаем выбрать Категорию (все категории)
    const catButtons = categoryOptions.map((opt, idx) => [
        Markup.button.callback(`${opt.name}`, `cat_${idx}`)
    ]);

    return ctx.reply(
        `Сумма: ${sum}, Название: "${title}", Валюта: ${currency}` +
        (dateString ? `, Дата: ${dateString}` : '') +
        `\nВыберите категорию:`,
        Markup.inlineKeyboard(catButtons)
    );
});

// Обработка нажатия кнопки Категория
bot.action(/^cat_(\d+)/, async (ctx) => {
    const userId = ctx.from.id;
    const idx = Number(ctx.match[1]);
    const chosenCat = categoryOptions[idx];

    if (!chosenCat) {
        await ctx.answerCbQuery();
        return ctx.reply('Категория не найдена. Введите заново.');
    }

    // Сохраняем название и цвет категории
    userState[userId].category = chosenCat.name;
    const catColor = chosenCat.color; // Важная часть

    // Предлагаем выбрать Подкатегорию
    // - Показываем ТОЛЬКО те подкатегории, чьё subcat.color == catColor
    const filteredSubcats = subcatOptions.filter((sub) => sub.color === catColor);

    if (!filteredSubcats.length) {
        await ctx.answerCbQuery();
        return ctx.reply(
            `Категория выбрана: ${chosenCat.name}\n` +
            `Нет подкатегорий с цветом (${catColor}). Пожалуйста, выберите другую категорию или настройте цвета в Notion.`
        );
    }

    const subcatButtons = filteredSubcats.map((opt, sidx) => [
        Markup.button.callback(opt.name, `subcat_${opt.id}`)
    ]);

    await ctx.answerCbQuery();
    return ctx.reply(
        `Категория выбрана: ${chosenCat.name}\nВыберите подкатегорию:`,
        Markup.inlineKeyboard(subcatButtons)
    );
});

// Обработка нажатия кнопки Подкатегория
// callback_data: "subcat_optnID"
bot.action(/^subcat_(.+)/, async (ctx) => {
    const userId = ctx.from.id;
    const subcatId = ctx.match[1]; // id в массиве subcatOptions

    // Ищем соответствующую подкатегорию
    const chosenSubcat = subcatOptions.find((o) => o.id === subcatId);

    if (!chosenSubcat) {
        await ctx.answerCbQuery();
        return ctx.reply('Подкатегория не найдена. Введите заново.');
    }

    userState[userId].subcategory = chosenSubcat.name;

    // Предлагаем выбрать Счёт
    const acctButtons = accountOptions.map((opt, aidx) => [
        Markup.button.callback(opt.name, `acct_${aidx}`)
    ]);

    await ctx.answerCbQuery();
    return ctx.reply(
        `Подкатегория выбрана: ${chosenSubcat.name}\nТеперь выберите счёт:`,
        Markup.inlineKeyboard(acctButtons)
    );
});

// Обработка нажатия кнопки Счёт
bot.action(/^acct_(\d+)/, async (ctx) => {
    const userId = ctx.from.id;
    const aidx = Number(ctx.match[1]);
    const chosenAcct = accountOptions[aidx];

    if (!chosenAcct) {
        await ctx.answerCbQuery();
        return ctx.reply('Счёт не найден. Введите заново.');
    }

    userState[userId].account = chosenAcct.name;

    // Считываем всё и очищаем
    const { sum, title, currency, dateString, category, subcategory, account } = userState[userId];
    delete userState[userId];

    // Определяем дату (если dateString есть — парсим, иначе сегодня)
    let targetDate = new Date();
    if (dateString) {
        targetDate = parseShortDateString(dateString);
    }

    // Вычисляем Месяц и Год
    const monthName = getRussianMonthName(targetDate.getMonth());
    const year = targetDate.getFullYear().toString();

    // Формируем ISO-дату (YYYY-MM-DD), чтобы передавать в Notion
    const isoDate = targetDate.toISOString().split('T')[0];

    // Создаём запись в Notion
    try {
        await notion.pages.create({
            parent: { database_id: databaseId },
            properties: {
                'Дата': {
                    date: { start: isoDate }
                },
                'Месяц': {
                    select: { name: monthName }
                },
                'Год': {
                    select: { name: year }
                },
                'Название': {
                    title: [{ text: { content: title } }]
                },
                'Категория': {
                    select: { name: category }
                },
                'Подкатегория': {
                    select: { name: subcategory }
                },
                'Сумма': {
                    number: sum
                },
                'Валюта': {
                    select: { name: currency }
                },
                'Счёт': {
                    select: { name: account }
                },
                'Тип операции': {
                    select: { name: 'Расход' }
                },
                'Статус': {
                    select: { name: 'Оплачено' }
                }
            }
        });

        await ctx.answerCbQuery();
        return ctx.reply(
            `✅ Запись добавлена в Notion!\n` +
            `Сумма: ${sum}\nНазвание: ${title}\nВалюта: ${currency}\n` +
            `Категория: ${category}\nПодкатегория: ${subcategory}\nСчёт: ${account}\n` +
            `Дата: ${isoDate} (Месяц: ${monthName}, Год: ${year})`
        );
    } catch (error) {
        console.error('Ошибка при создании страницы в Notion:', error);
        await ctx.answerCbQuery();
        return ctx.reply('Произошла ошибка при сохранении в Notion.');
    }
});

// Запуск бота
await bot.launch();
console.log('Бот запущен!');
