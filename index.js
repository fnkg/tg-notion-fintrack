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
// userState[userId] = { chosenCategory: null, chosenSubcategory: null, ... }
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

// --- Вспомогательная функция: парсим строку вида "3000.45 Такси до отеля USD"
function parseUserInput(input) {
    // Разбиваем по пробелам
    const tokens = input.trim().split(/\s+/);

    if (!tokens.length) return null;

    // 1) Первая часть — сумма
    const sumRaw = tokens[0];
    const sum = parseFloat(sumRaw.replace(',', '.')); // на случай, если пользователь пишет 3000,50
    if (isNaN(sum)) {
        return null; // не число
    }

    // 2) Проверяем последнюю часть на валюта ли это
    // Разрешённые валюты
    const allowedCurrencies = ['TRY', 'GEL', 'USD', 'RUB'];
    let currency = 'RUB';
    let titleTokens = tokens.slice(1); // всё, кроме первого

    const lastToken = titleTokens[titleTokens.length - 1];
    if (allowedCurrencies.includes(lastToken?.toUpperCase())) {
        currency = lastToken.toUpperCase();
        titleTokens = titleTokens.slice(0, -1); // убираем последний
    }

    // 3) Всё, что осталось в середине, — это название (может быть с пробелами)
    const title = titleTokens.join(' ').trim() || '(без названия)';

    return { sum, title, currency };
}

// 1) При запуске бота загружаем схему базы и извлекаем варианты select
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

console.log(dbInfo)
console.log('Список категорий из Notion:', categoryOptions.map(o => o.name));
console.log('Список подкатегорий из Notion:', subcatOptions.map(o => o.name));
console.log('Список счетов из Notion:', accountOptions.map(o => o.name));


// 2) Определяем логику бота

// Команда /start — приветствие
bot.start((ctx) => {
    ctx.reply(
        'Привет! Для добавления операции напиши:\n' +
        'сумма название [валюта]\n\n' +
        'Пример: "3000.45 Такси до отеля USD"\n' +
        'или: "1500 Жевачка"\n'
    );
});

// Хендлер для произвольного текста (шаг 2 - ввод данных)
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const parsed = parseUserInput(ctx.message.text);
    if (!parsed) {
        return ctx.reply(
            'Не удалось распознать данные. Формат: "3000.45 Название [опц. валюта]".'
        );
    }

    const { sum, title, currency } = parsed;

    // Сохраняем во временное состояние
    userState[userId] = {
        sum,
        title,
        currency,
        category: null,
        subcategory: null,
        account: null
    };

    // 3) Предлагаем выбрать Категорию
    // Формируем кнопки: callback_data = `cat_0`, `cat_1`, ...
    const catButtons = categoryOptions.map((opt, idx) => [
        Markup.button.callback(opt.name, `cat_${idx}`)
    ]);

    return ctx.reply(
        `Сумма: ${sum}, Название: "${title}", Валюта: ${currency}.\nВыберите категорию:`,
        Markup.inlineKeyboard(catButtons)
    );
});

// 4) Нажатие кнопки "Категория"
bot.action(/^cat_(\d+)/, async (ctx) => {
    const userId = ctx.from.id;
    const idx = Number(ctx.match[1]);

    const chosenCat = categoryOptions[idx];
    if (!chosenCat) {
        await ctx.answerCbQuery();
        return ctx.reply('Категория не найдена. Введите операцию заново.');
    }

    // Сохраняем категорию
    userState[userId].category = chosenCat.name;

    // Предлагаем выбрать подкатегорию
    const subcatButtons = subcatOptions.map((opt, sidx) => [
        Markup.button.callback(opt.name, `subcat_${sidx}`)
    ]);

    await ctx.answerCbQuery();
    return ctx.reply(
        `Категория выбрана: ${chosenCat.name}.\nВыберите подкатегорию:`,
        Markup.inlineKeyboard(subcatButtons)
    );
});

// 5) Нажатие кнопки "Подкатегория"
bot.action(/^subcat_(\d+)/, async (ctx) => {
    const userId = ctx.from.id;
    const sidx = Number(ctx.match[1]);

    const chosenSubcat = subcatOptions[sidx];
    if (!chosenSubcat) {
        await ctx.answerCbQuery();
        return ctx.reply('Подкатегория не найдена. Введите операцию заново.');
    }

    userState[userId].subcategory = chosenSubcat.name;

    // Предлагаем выбрать "Счёт"
    const acctButtons = accountOptions.map((opt, aidx) => [
        Markup.button.callback(opt.name, `acct_${aidx}`)
    ]);

    await ctx.answerCbQuery();
    return ctx.reply(
        `Подкатегория выбрана: ${chosenSubcat.name}.\nТеперь выберите счёт:`,
        Markup.inlineKeyboard(acctButtons)
    );
});

// 6) Нажатие кнопки "Счёт"
bot.action(/^acct_(\d+)/, async (ctx) => {
    const userId = ctx.from.id;
    const aidx = Number(ctx.match[1]);

    const chosenAcct = accountOptions[aidx];
    if (!chosenAcct) {
        await ctx.answerCbQuery();
        return ctx.reply('Счёт не найден. Введите операцию заново.');
    }

    // Сохраняем "Счёт"
    userState[userId].account = chosenAcct.name;

    const { sum, title, currency, category, subcategory, account } = userState[userId];
    delete userState[userId]; // очистили память

    // Определяем текущий месяц
    const now = new Date();
    const monthName = getRussianMonthName(now.getMonth());
    const year = now.getFullYear().toString();

    console.log(monthName);
    console.log(year)

    // Теперь создаём запись в Notion. Заполняем как минимум:
    // - "Название" (Title)
    // - "Сумма" (Number)
    // - "Категория" (Select)
    // - "Подкатегория" (Select)
    // - "Счёт" (Select)
    // - "Валюта" (Select)
    // И т. д. — при желании можно добавить "Дата", "Месяц", "Год", "Статус"…

    try {
        await notion.pages.create({
            parent: { database_id: databaseId },
            properties: {
                'Дата': {
                    date: { start: new Date().toISOString().split('T')[0] }
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
            `Сумма: ${sum},\nНазвание: ${title},\nВалюта: ${currency},\n` +
            `Категория: ${category},\nПодкатегория: ${subcategory},\nСчёт: ${account}`
        );
    } catch (error) {
        console.error('Ошибка при создании страницы в Notion:', error);
        await ctx.answerCbQuery();
        return ctx.reply('Произошла ошибка при сохранении в Notion.');
    }
});

// 7) Запуск бота
await bot.launch();
console.log('Бот запущен!');